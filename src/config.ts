import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { systemTimeZone, WEEKDAYS, type Weekday } from "./time.js";
import { PROVIDERS, type Provider } from "./usage.js";

export type Size = "small" | "medium" | "large";

export interface Config {
  /** IANA time zone used for day boundaries and the release hour. */
  timezone: string;
  /** Weekly % held back each day for your own (non-queue) use. */
  reserves: Record<Weekday, number>;
  /** The queue never pushes weekly usage past this %. */
  weeklyCap: number;
  /** Local hour (0-23) when today's unused reserve is freed for the queue. */
  releaseHour: number;
  /** In the last N hours before the weekly reset, all reserves are freed. */
  sweepHours: number;
  presence: {
    /** Auto mode switches to Away after this many idle minutes. */
    idleMinutes: number;
  };
  fiveHour: {
    /** While Active, only start a task if the 5-hour window is below this %. */
    maxWhileActive: number;
    /** While Away, only start a task if the 5-hour window is below this %. */
    maxWhileAway: number;
  };
  /** Starting estimates per task size, before your own run history takes over. */
  estimates: Record<Size, { pct: number; minutes: number }>;
  run: {
    /** Path or name of the Claude Code CLI. */
    claudePath: string;
    model?: string;
    timeoutMinutes: number;
    /** Re-read usage before a run if the newest reading is older than this. */
    staleMinutes: number;
    researchTools: string[];
    codeTools: string[];
    /** Push the branch and open a draft PR with `gh` after a coding task. */
    openDraftPr: boolean;
  };
  /**
   * Which plans the queue may spend, in order. A task with no engine of its own runs on
   * the first one here that has room. `setup` adds Codex when it finds it installed.
   */
  engines: Provider[];
  /** How queued tasks run on Codex (OpenAI's coding agent, on a ChatGPT plan). */
  codex: {
    /** Path or name of the Codex CLI. */
    path: string;
    model?: string;
    /** Let research tasks search the web. */
    search: boolean;
  };
  /** What the Claude Code mod does when your own use runs past today's reserve. */
  guard: "off" | "warn" | "block";
  /** Where Node and this CLI live, so the Claude Code mod can call it. Set by `init`. */
  integration?: { node: string; cli: string };
  statusline: {
    /** Your previous status line command. Backburner runs it and prints its output first. */
    chain?: string;
    /** Print Backburner's own line under the chained output. */
    showLine: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  timezone: systemTimeZone(),
  reserves: { mon: 5, tue: 5, wed: 5, thu: 5, fri: 5, sat: 3, sun: 3 },
  weeklyCap: 95,
  releaseHour: 23,
  sweepHours: 12,
  presence: { idleMinutes: 30 },
  fiveHour: { maxWhileActive: 50, maxWhileAway: 90 },
  estimates: {
    small: { pct: 1, minutes: 10 },
    medium: { pct: 3, minutes: 30 },
    large: { pct: 8, minutes: 90 },
  },
  run: {
    claudePath: "claude",
    timeoutMinutes: 60,
    staleMinutes: 20,
    researchTools: ["WebSearch", "WebFetch", "Read", "Grep", "Glob"],
    codeTools: [
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
      "Bash(npm test:*)",
      "Bash(npm run:*)",
    ],
    openDraftPr: true,
  },
  engines: ["claude"],
  codex: { path: "codex", search: true },
  guard: "warn",
  statusline: { showLine: true },
};

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Plain)[k], v);
  return out as T;
}

export function validate(c: Config): string[] {
  const errors: string[] = [];
  const pct = (name: string, v: unknown) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) errors.push(`${name} must be a number from 0 to 100`);
  };
  for (const d of WEEKDAYS) pct(`reserves.${d}`, c.reserves[d]);
  pct("weeklyCap", c.weeklyCap);
  pct("fiveHour.maxWhileActive", c.fiveHour.maxWhileActive);
  pct("fiveHour.maxWhileAway", c.fiveHour.maxWhileAway);
  if (!Number.isInteger(c.releaseHour) || c.releaseHour < 0 || c.releaseHour > 24) errors.push("releaseHour must be a whole hour from 0 to 24");
  if (typeof c.sweepHours !== "number" || c.sweepHours < 0) errors.push("sweepHours must be 0 or more");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
  } catch {
    errors.push(`timezone "${c.timezone}" is not a valid IANA time zone`);
  }
  if (!["off", "warn", "block"].includes(c.guard)) errors.push('guard must be "off", "warn" or "block"');
  if (!Array.isArray(c.engines) || c.engines.length === 0 || c.engines.some((e) => !PROVIDERS.includes(e))) {
    errors.push(`engines must list one or more of: ${PROVIDERS.join(", ")}`);
  }
  const weekly = WEEKDAYS.reduce((s, d) => s + c.reserves[d], 0);
  if (weekly > c.weeklyCap) errors.push(`reserves add up to ${weekly}%, more than the ${c.weeklyCap}% cap, so the queue could never run`);
  return errors;
}

export function loadConfig(): Config {
  return merge(DEFAULT_CONFIG, readJson<unknown>(paths.config(), {}));
}

export function saveConfig(c: Config): void {
  writeJson(paths.config(), c);
}

/** Set a dotted key such as `reserves.mon` or `run.model`. Numbers and booleans are parsed. */
export function setConfigValue(c: Config, key: string, raw: string): Config {
  const parts = key.split(".");
  const next = structuredClone(c) as unknown as Plain;
  let node: Plain = next;
  for (const p of parts.slice(0, -1)) {
    if (!isPlain(node[p])) throw new Error(`Unknown config key: ${key}`);
    node = node[p] as Plain;
  }
  const leaf = parts.at(-1)!;
  if (!(leaf in node) && !((parts[0] === "run" || parts[0] === "codex") && leaf === "model") && !(parts[0] === "statusline" && leaf === "chain")) {
    throw new Error(`Unknown config key: ${key}`);
  }
  const current = node[leaf];
  let value: unknown = raw;
  if (typeof current === "number") value = Number(raw);
  else if (typeof current === "boolean") value = raw === "true";
  else if (Array.isArray(current)) value = raw.split(",").map((s) => s.trim()).filter(Boolean);
  node[leaf] = value;
  return next as unknown as Config;
}
