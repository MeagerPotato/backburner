import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { computeBudget } from "../src/budget.js";
import { DEFAULT_CONFIG, setConfigValue, validate } from "../src/config.js";
import { resolvePresence } from "../src/presence.js";
import { compareTasks, estimate, pickNext, queueSpentSince, type Run, type Task } from "../src/tasks.js";
import { localParts, nextLocalDay, startOfLocalDay, zonedToUtc } from "../src/time.js";
import { latest, parseStatusline, parseStreamEvent, recordSnapshot, loadSnapshots, weeklyAtDayStart, type Snapshot } from "../src/usage.js";

const TZ = "America/Los_Angeles";
const at = (y: number, mo: number, d: number, h: number, mi = 0) => zonedToUtc(y, mo, d, h, mi, TZ);
const flat5 = { mon: 5, tue: 5, wed: 5, thu: 5, fri: 5, sat: 5, sun: 5 };
const cfg = { timezone: TZ, reserves: flat5, weeklyCap: 95, releaseHour: 23, sweepHours: 12 };

beforeEach(() => {
  process.env.BACKBURNER_HOME = mkdtempSync(join(tmpdir(), "bb-test-"));
});

describe("time", () => {
  it("finds local midnight and weekday", () => {
    const thu9pm = at(2026, 10, 22, 21);
    expect(localParts(thu9pm, TZ)).toMatchObject({ weekday: "thu", hour: 21, day: 22 });
    expect(localParts(startOfLocalDay(thu9pm, TZ), TZ)).toMatchObject({ day: 22, hour: 0, minute: 0 });
  });

  it("steps over the November DST change to the next midnight", () => {
    const sat = at(2026, 10, 31, 0);
    const sun = nextLocalDay(sat, TZ);
    const mon = nextLocalDay(sun, TZ);
    expect(localParts(sun, TZ)).toMatchObject({ day: 1, hour: 0 });
    expect(localParts(mon, TZ)).toMatchObject({ day: 2, hour: 0 });
    expect(mon - sun).toBe(25 * 3_600_000);
  });
});

describe("computeBudget", () => {
  const reset = at(2026, 10, 26, 0); // Monday midnight

  it("matches the plan's worked example: Thursday 9pm gives 18%", () => {
    const b = computeBudget({ now: at(2026, 10, 22, 21), config: cfg, weeklyPct: 58, resetsAt: reset, dayStartPct: 57, queueSpentToday: 0 });
    expect(b.personalToday).toBe(1);
    expect(b.todayHeld).toBe(4);
    expect(b.futureHeld).toBe(15); // Fri, Sat, Sun
    expect(b.available).toBe(18);
  });

  it("doesn't count the queue's own spend as your personal use", () => {
    const b = computeBudget({ now: at(2026, 10, 22, 21), config: cfg, weeklyPct: 58, resetsAt: reset, dayStartPct: 50, queueSpentToday: 7 });
    expect(b.personalToday).toBe(1);
    expect(b.available).toBe(18);
  });

  it("frees today's leftover at the release hour", () => {
    const b = computeBudget({ now: at(2026, 10, 22, 23, 30), config: cfg, weeklyPct: 58, resetsAt: reset, dayStartPct: 57, queueSpentToday: 0 });
    expect(b.released).toBe(true);
    expect(b.todayHeld).toBe(0);
    expect(b.available).toBe(22);
  });

  it("frees everything in the final sweep window", () => {
    const b = computeBudget({ now: at(2026, 10, 25, 14), config: cfg, weeklyPct: 80, resetsAt: reset, dayStartPct: 79, queueSpentToday: 0 });
    expect(b.sweeping).toBe(true);
    expect(b.available).toBe(15);
  });

  it("prorates a day the reset cuts short", () => {
    const tue2am = at(2026, 10, 27, 2);
    const b = computeBudget({ now: at(2026, 10, 25, 9), config: cfg, weeklyPct: 10, resetsAt: tue2am, dayStartPct: 10, queueSpentToday: 0 });
    // Mon full (5) + Tue for 2 of 24 hours (0.4)
    expect(b.futureHeld).toBe(5.4);
  });

  it("never goes negative when you've overspent", () => {
    const b = computeBudget({ now: at(2026, 10, 22, 9), config: cfg, weeklyPct: 94, resetsAt: reset, dayStartPct: 90, queueSpentToday: 0 });
    expect(b.available).toBe(0);
  });
});

describe("usage parsing", () => {
  it("reads the status line's rate_limits", () => {
    const s = parseStatusline({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } }, 1);
    expect(s?.weekly).toEqual({ pct: 41.2, resetsAt: 1738857600_000 });
    expect(s?.fiveHour?.pct).toBe(23.5);
  });

  it("returns nothing when the status line has no rate limits", () => {
    expect(parseStatusline({ model: { id: "x" } })).toBeUndefined();
  });

  it("reads stream-json rate_limit_event and converts 0..1 to percent", () => {
    const e = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1792683000 }, seven_day: { utilization: 0.6, resetsAt: 1792994400 } } },
    };
    const s = parseStreamEvent(e, 1);
    expect(s?.weekly?.pct).toBeCloseTo(60);
    expect(s?.fiveHour?.pct).toBeCloseTo(5);
  });

  it("finds weekly usage at the start of today", () => {
    const reset = at(2026, 10, 26, 0);
    const w = (pct: number) => ({ pct, resetsAt: reset });
    const snaps: Snapshot[] = [
      { at: at(2026, 10, 21, 22), weekly: w(50), source: "statusline" },
      { at: at(2026, 10, 22, 10), weekly: w(55), source: "statusline" },
    ];
    expect(weeklyAtDayStart(snaps, at(2026, 10, 22, 21), TZ, w(58))).toBe(50);
    // No reading before midnight: use the first reading today.
    expect(weeklyAtDayStart(snaps.slice(1), at(2026, 10, 22, 21), TZ, w(58))).toBe(55);
    // Week started today: day starts at 0.
    expect(weeklyAtDayStart([], at(2026, 10, 26, 9), TZ, { pct: 3, resetsAt: at(2026, 11, 2, 0) })).toBe(0);
  });

  it("stores readings and skips repeats", () => {
    const s: Snapshot = { at: 1_000_000, weekly: { pct: 40, resetsAt: 9e12 }, source: "statusline" };
    recordSnapshot(s);
    recordSnapshot({ ...s, at: 1_060_000 });
    recordSnapshot({ ...s, at: 1_120_000, weekly: { pct: 41, resetsAt: 9e12 } });
    expect(loadSnapshots()).toHaveLength(2);
    expect(latest(loadSnapshots()).weekly?.pct).toBe(41);
  });
});

describe("queue", () => {
  const task = (over: Partial<Task>): Task => ({
    id: Math.random().toString(16).slice(2, 8),
    title: "t",
    prompt: "p",
    dir: ".",
    mode: "research",
    priority: 3,
    size: "medium",
    status: "queued",
    createdAt: 0,
    attempts: 0,
    ...over,
  });

  it("orders by deadline, then priority, then age", () => {
    const a = task({ id: "a", priority: 5 });
    const b = task({ id: "b", deadline: "2026-10-30" });
    const c = task({ id: "c", deadline: "2026-10-24", priority: 1 });
    const d = task({ id: "d", priority: 5, createdAt: -1 });
    expect([a, b, c, d].sort(compareTasks).map((t) => t.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("skips tasks that don't fit the budget", () => {
    const big = task({ id: "big", size: "large", priority: 5 });
    const small = task({ id: "small", size: "small" });
    expect(pickNext([big, small], 2, [], DEFAULT_CONFIG)?.id).toBe("small");
    expect(pickNext([big, small], 0.5, [], DEFAULT_CONFIG)).toBeUndefined();
  });

  it("learns estimates from three or more finished runs", () => {
    const run = (pct: number, min: number): Run => ({ id: "r", taskId: "t", size: "small", startedAt: 0, endedAt: min * 60_000, weeklyBefore: 10, weeklyAfter: 10 + pct, outcome: "done" });
    expect(estimate("small", [run(2, 20), run(2, 20)], DEFAULT_CONFIG).basis).toBe("default");
    const e = estimate("small", [run(2, 20), run(4, 40), run(3, 30)], DEFAULT_CONFIG);
    expect(e).toEqual({ pct: 3, minutes: 30, basis: "history" });
  });

  it("sums the queue's spend within one weekly window", () => {
    const runs: Run[] = [
      { id: "1", taskId: "t", size: "small", startedAt: 100, weeklyBefore: 10, weeklyAfter: 12, weeklyResetsAt: 5e12 },
      { id: "2", taskId: "t", size: "small", startedAt: 200, weeklyBefore: 12, weeklyAfter: 15, weeklyResetsAt: 5e12 },
      { id: "3", taskId: "t", size: "small", startedAt: 50, weeklyBefore: 1, weeklyAfter: 9, weeklyResetsAt: 5e12 },
    ];
    expect(queueSpentSince(runs, 100, 5e12)).toBe(5);
  });
});

describe("presence", () => {
  const now = 10_000_000;
  it("respects manual modes", () => {
    expect(resolvePresence({ mode: "away" }, 30, now, 0).effective).toBe("away");
    expect(resolvePresence({ mode: "active" }, 30, now, 1e9).effective).toBe("active");
  });
  it("auto needs both prompt and input idle", () => {
    expect(resolvePresence({ mode: "auto", lastPromptAt: now - 5 * 60_000 }, 30, now, 1e9).effective).toBe("active");
    expect(resolvePresence({ mode: "auto", lastPromptAt: now - 60 * 60_000 }, 30, now, 60_000).effective).toBe("active");
    expect(resolvePresence({ mode: "auto", lastPromptAt: now - 60 * 60_000 }, 30, now, 45 * 60_000).effective).toBe("away");
    expect(resolvePresence({ mode: "auto" }, 30, now, undefined).effective).toBe("away");
  });
});

describe("config", () => {
  it("sets nested numbers and rejects unknown keys", () => {
    const c = setConfigValue(DEFAULT_CONFIG, "reserves.sat", "2");
    expect(c.reserves.sat).toBe(2);
    expect(() => setConfigValue(DEFAULT_CONFIG, "reserves.funday", "2")).toThrow();
    expect(setConfigValue(DEFAULT_CONFIG, "run.model", "sonnet").run.model).toBe("sonnet");
  });
  it("flags reserves that leave no room under the cap", () => {
    const c = setConfigValue(DEFAULT_CONFIG, "weeklyCap", "20");
    expect(validate(c).join(" ")).toMatch(/more than the 20% cap/);
    expect(validate({ ...DEFAULT_CONFIG, timezone: "Mars/Olympus" }).join(" ")).toMatch(/time zone/);
  });
});
