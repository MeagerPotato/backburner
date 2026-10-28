import { estimate, loadRuns, loadTasks, runsOn, type Run, type Task } from "./tasks.js";
import { currentState, decide, enginesOf } from "./tick.js";
import { PROVIDER_NAMES, type Provider } from "./usage.js";

/** One plan's numbers: usage, what the queue may spend, and what runs next on it. */
export interface EngineSummary {
  provider: Provider;
  name: string;
  weekly: { pct: number; resetsAt: number; at: number } | null;
  fiveHour: { pct: number; resetsAt: number } | null;
  budget: {
    available: number;
    cap: number;
    used: number;
    todayReserve: number;
    todayHeld: number;
    personalToday: number;
    futureHeld: number;
    sweeping: boolean;
    released: boolean;
  } | null;
  /** How far your own use today has gone past today's reserve, in weekly %. */
  overToday: number;
  /** How much of later days' reserves is already used up, in weekly %. */
  eatingFuture: number;
  /** Queued tasks that may run on this plan, and their estimated total. */
  queued: number;
  queuedPct: number;
  next: { run: boolean; taskId?: string; title?: string; why: string };
}

/**
 * The one JSON shape the CLI hands to the Claude Code mod and to `status --json`.
 * The top level is the main plan (Claude when it's enabled); `engines` lists every plan.
 */
export interface Summary extends Omit<EngineSummary, "provider" | "name"> {
  presence: { effective: "active" | "away"; mode: "auto" | "active" | "away"; reason: string };
  guard: "off" | "warn" | "block";
  timezone: string;
  engines: EngineSummary[];
}

const round = (n: number) => Math.round(n * 10) / 10;

function engineSummary(provider: Provider, now: number, opts: { idle?: boolean }, tasks: Task[], runs: Run[]) {
  const s = currentState(now, { ...opts, provider });
  const d = decide(s, tasks, runs);
  const queued = tasks.filter((t) => t.status === "queued" && runsOn(t, provider, s.config.engines));
  const b = s.budget;
  const engine: EngineSummary = {
    provider,
    name: PROVIDER_NAMES[provider],
    weekly: s.weekly ? { pct: s.weekly.pct, resetsAt: s.weekly.resetsAt, at: s.weekly.at } : null,
    fiveHour: s.fiveHour ? { pct: s.fiveHour.pct, resetsAt: s.fiveHour.resetsAt } : null,
    budget: b
      ? {
          available: b.available,
          cap: b.cap,
          used: b.used,
          todayReserve: b.todayReserve,
          todayHeld: b.todayHeld,
          personalToday: b.personalToday,
          futureHeld: b.futureHeld,
          sweeping: b.sweeping,
          released: b.released,
        }
      : null,
    overToday: b ? round(Math.max(0, b.personalToday - b.todayReserve)) : 0,
    eatingFuture: b ? round(Math.max(0, b.used + b.futureHeld + b.todayHeld - b.cap)) : 0,
    queued: queued.length,
    queuedPct: round(queued.reduce((sum, t) => sum + estimate(t.size, runs, s.config, provider).pct, 0)),
    next: { run: d.run, taskId: d.task?.id, title: d.task?.title, why: d.why },
  };
  return { engine, state: s };
}

export function summary(now = Date.now(), opts: { idle?: boolean } = {}): Summary {
  const tasks = loadTasks();
  const runs = loadRuns();
  const first = engineSummary("claude", now, opts, tasks, runs);
  const engines = enginesOf(first.state.config);
  const all = engines.map((p) => (p === "claude" ? first.engine : engineSummary(p, now, opts, tasks, runs).engine));
  const main = all.find((e) => e.provider === "claude") ?? all[0]!;
  const { provider: _p, name: _n, ...top } = main;
  const s = first.state;
  return {
    ...top,
    queued: tasks.filter((t) => t.status === "queued").length,
    presence: s.presence,
    guard: s.config.guard,
    timezone: s.config.timezone,
    engines: all,
  };
}
