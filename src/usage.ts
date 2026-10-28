import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { DAY, HOUR, startOfLocalDay } from "./time.js";

export interface Window {
  /** Percent used, 0 to 100. */
  pct: number;
  /** Epoch ms when the window resets. */
  resetsAt: number;
}

/** Whose plan a reading is for. Readings saved before Codex support have none: Claude. */
export type Provider = "claude" | "codex";
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

export interface Snapshot {
  at: number;
  weekly?: Window;
  fiveHour?: Window;
  source: "statusline" | "stream" | "probe" | "codex";
  provider?: Provider;
}

export const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export const providerOf = (s: { provider?: Provider }): Provider => s.provider ?? "claude";

const KEEP_MS = 14 * DAY;

/** Saved readings, oldest first; only one provider's when `provider` is given. */
export function loadSnapshots(provider?: Provider): Snapshot[] {
  const all = readJson<Snapshot[]>(paths.usage(), []);
  return provider ? all.filter((s) => providerOf(s) === provider) : all;
}

export function recordSnapshot(s: Snapshot): void {
  if (!s.weekly && !s.fiveHour) return;
  const all = loadSnapshots().filter((x) => x.at > s.at - KEEP_MS);
  const last = all.filter((x) => providerOf(x) === providerOf(s)).at(-1);
  // Status lines redraw constantly. Skip readings that add nothing new.
  if (
    last &&
    s.at - last.at < 5 * 60_000 &&
    last.weekly?.pct === s.weekly?.pct &&
    last.fiveHour?.pct === s.fiveHour?.pct &&
    last.weekly?.resetsAt === s.weekly?.resetsAt
  ) {
    return;
  }
  all.push(s);
  all.sort((a, b) => a.at - b.at);
  writeJson(paths.usage(), all);
}

/** Newest reading that has each window. */
export function latest(snaps: Snapshot[]): { weekly?: Window & { at: number }; fiveHour?: Window & { at: number } } {
  let weekly: (Window & { at: number }) | undefined;
  let fiveHour: (Window & { at: number }) | undefined;
  for (let i = snaps.length - 1; i >= 0 && (!weekly || !fiveHour); i--) {
    const s = snaps[i]!;
    if (!weekly && s.weekly) weekly = { ...s.weekly, at: s.at };
    if (!fiveHour && s.fiveHour) fiveHour = { ...s.fiveHour, at: s.at };
  }
  return { weekly, fiveHour };
}

/** Two readings belong to the same weekly window if their reset times are within an hour. */
export function sameWeek(a: Window, b: Window): boolean {
  return Math.abs(a.resetsAt - b.resetsAt) < HOUR;
}

/**
 * Weekly % at the start of today (local midnight), or at the start of the week if
 * it began today. Uses the last reading before midnight; falls back to `current`
 * (meaning "assume you haven't used anything yet today", which keeps your full reserve).
 */
export function weeklyAtDayStart(snaps: Snapshot[], now: number, timeZone: string, current: Window): number {
  const dayStart = startOfLocalDay(now, timeZone);
  let before: Snapshot | undefined;
  let firstToday: Snapshot | undefined;
  for (const s of snaps) {
    if (!s.weekly || !sameWeek(s.weekly, current)) continue;
    if (s.at <= dayStart) before = s;
    else if (!firstToday && s.at <= now) firstToday = s;
  }
  if (before?.weekly) return before.weekly.pct;
  const weekStart = current.resetsAt - 7 * DAY;
  if (weekStart >= dayStart && weekStart <= now) return 0;
  if (firstToday?.weekly) return firstToday.weekly.pct;
  return current.pct;
}

// ---------- parsing ----------

const toMs = (epoch: unknown): number | undefined => {
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) return undefined;
  return epoch < 1e12 ? epoch * 1000 : epoch;
};

function windowFromStatusline(w: unknown): Window | undefined {
  if (!w || typeof w !== "object") return undefined;
  const { used_percentage, resets_at } = w as { used_percentage?: unknown; resets_at?: unknown };
  const resetsAt = toMs(resets_at);
  if (typeof used_percentage !== "number" || resetsAt === undefined) return undefined;
  return { pct: used_percentage, resetsAt };
}

/** Reads `rate_limits` from the JSON Claude Code sends to status line commands. */
export function parseStatusline(input: unknown, at = Date.now()): Snapshot | undefined {
  const rl = (input as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } } | undefined)?.rate_limits;
  if (!rl) return undefined;
  const snap: Snapshot = {
    at,
    source: "statusline",
    weekly: windowFromStatusline(rl.seven_day),
    fiveHour: windowFromStatusline(rl.five_hour),
  };
  return snap.weekly || snap.fiveHour ? snap : undefined;
}

function windowFromStream(w: unknown): Window | undefined {
  if (!w || typeof w !== "object") return undefined;
  const { utilization, resetsAt } = w as { utilization?: unknown; resetsAt?: unknown };
  const ms = toMs(resetsAt);
  if (typeof utilization !== "number" || ms === undefined) return undefined;
  // The stream reports 0..1; the status line reports 0..100.
  return { pct: utilization <= 1 ? utilization * 100 : utilization, resetsAt: ms };
}

/** Reads a `rate_limit_event` line from `claude -p --output-format stream-json`. */
export function parseStreamEvent(event: unknown, at = Date.now()): Snapshot | undefined {
  const e = event as { type?: string; rate_limit_info?: { unifiedWindows?: Record<string, unknown> } };
  if (e?.type !== "rate_limit_event") return undefined;
  const w = e.rate_limit_info?.unifiedWindows;
  if (!w) return undefined;
  const snap: Snapshot = {
    at,
    source: "stream",
    weekly: windowFromStream(w.seven_day),
    fiveHour: windowFromStream(w.five_hour),
  };
  return snap.weekly || snap.fiveHour ? snap : undefined;
}

/** True when a stream event says requests are being refused because of a limit. */
export function isRejection(event: unknown): boolean {
  const e = event as { type?: string; rate_limit_info?: { status?: string } };
  return e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected";
}

// ---------- Codex ----------

/** Codex keeps its own logs under CODEX_HOME (default ~/.codex). */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function codexWindow(w: unknown, recordAt: number): { win: Window; minutes?: number } | undefined {
  if (!w || typeof w !== "object") return undefined;
  const o = w as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown; resets_in_seconds?: unknown };
  if (typeof o.used_percent !== "number") return undefined;
  const resetsAt = toMs(o.resets_at) ?? (typeof o.resets_in_seconds === "number" ? recordAt + o.resets_in_seconds * 1000 : undefined);
  if (resetsAt === undefined) return undefined;
  return { win: { pct: o.used_percent, resetsAt }, minutes: typeof o.window_minutes === "number" ? o.window_minutes : undefined };
}

/**
 * Reads one line of a Codex session log. Codex writes a `token_count` event with
 * `rate_limits` after each model call: `primary` is the 5-hour window and
 * `secondary` the weekly one (told apart by `window_minutes` when present).
 */
export function parseCodexRecord(record: unknown): Snapshot | undefined {
  type TokenCount = { type?: string; rate_limits?: Record<string, unknown> | null };
  const r = record as { timestamp?: string; type?: string; payload?: TokenCount } | undefined;
  // Session logs wrap the event as {type: "event_msg", payload}; older builds wrote it bare.
  const p: TokenCount | undefined = r?.type === "event_msg" ? r.payload : (r as TokenCount | undefined);
  const limits = p?.type === "token_count" ? p.rate_limits : undefined;
  if (!limits) return undefined;
  const parsed = r?.timestamp ? Date.parse(r.timestamp) : NaN;
  const snap: Snapshot = { at: Number.isFinite(parsed) ? parsed : Date.now(), source: "codex", provider: "codex" };
  for (const key of ["primary", "secondary"]) {
    const w = codexWindow(limits[key], snap.at);
    if (!w) continue;
    const weekly = w.minutes !== undefined ? w.minutes > 24 * 60 : key === "secondary";
    if (weekly) snap.weekly = w.win;
    else snap.fiveHour = w.win;
  }
  return snap.weekly || snap.fiveHour ? snap : undefined;
}

/** Newest Codex usage reading in its session logs from the last few days, if any. */
export function readCodexUsage(now = Date.now(), home = codexHome()): Snapshot | undefined {
  const root = join(home, "sessions");
  const files: { path: string; mtime: number }[] = [];
  for (let d = 0; d < 8; d++) {
    const day = new Date(now - d * DAY);
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      try {
        files.push({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs });
      } catch {
        // Gone already.
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 5)) {
    const snap = lastCodexReading(f.path);
    if (snap) return snap;
  }
  return undefined;
}

/** Scans a session log from the end (only its last 512 KB) for the newest usage reading. */
function lastCodexReading(file: string): Snapshot | undefined {
  let text: string;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 512 * 1024);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("rate_limits")) continue;
    try {
      const snap = parseCodexRecord(JSON.parse(line));
      if (snap) return snap;
    } catch {
      // A line cut by the 512 KB window.
    }
  }
  return undefined;
}
