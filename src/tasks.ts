import { randomBytes } from "node:crypto";
import type { Config, Size } from "./config.js";
import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { providerOf, type Provider } from "./usage.js";

export type Mode = "research" | "code";
export type Status = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  /** Folder the task runs in. For coding tasks, a git repo. */
  dir: string;
  mode: Mode;
  /** 1 (low) to 5 (high). */
  priority: number;
  /** ISO date or date-time. Tasks due before others go first. */
  deadline?: string;
  size: Size;
  /** Which plan runs it. Unset: the first engine in the config with room. */
  engine?: Provider;
  status: Status;
  createdAt: number;
  attempts: number;
  note?: string;
  /** Where the last run left its result: a report file or a branch/PR. */
  result?: string;
}

export interface Run {
  id: string;
  taskId: string;
  size: Size;
  /** Whose plan the run spent. Runs saved before Codex support have none: Claude. */
  provider?: Provider;
  startedAt: number;
  endedAt?: number;
  /** Weekly % right before and right after the run. */
  weeklyBefore?: number;
  weeklyAfter?: number;
  /** The weekly window this run belonged to. */
  weeklyResetsAt?: number;
  outcome?: "done" | "failed" | "limit" | "timeout";
}

export const newId = () => randomBytes(3).toString("hex");

export function loadTasks(): Task[] {
  return readJson<Task[]>(paths.tasks(), []);
}

export function saveTasks(tasks: Task[]): void {
  writeJson(paths.tasks(), tasks);
}

export function loadRuns(): Run[] {
  return readJson<Run[]>(paths.runs(), []);
}

export function saveRuns(runs: Run[]): void {
  writeJson(paths.runs(), runs.slice(-500));
}

export function findTask(tasks: Task[], idOrPrefix: string): Task | undefined {
  const matches = tasks.filter((t) => t.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

export function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

const deadlineMs = (t: Task) => (t.deadline ? Date.parse(t.deadline) : Number.POSITIVE_INFINITY);

/** Earliest deadline first, then higher priority, then oldest. */
export function compareTasks(a: Task, b: Task): number {
  return deadlineMs(a) - deadlineMs(b) || b.priority - a.priority || a.createdAt - b.createdAt;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

export interface Estimate {
  pct: number;
  minutes: number;
  /** "history" once three or more finished runs of that size exist. */
  basis: "default" | "history";
}

/**
 * Estimate from your own finished runs of the same size on the same plan, or the
 * configured defaults. Plans differ in size, so a Codex run says nothing about Claude.
 */
export function estimate(size: Size, runs: Run[], config: Pick<Config, "estimates">, provider: Provider = "claude"): Estimate {
  const done = runs.filter(
    (r) => r.size === size && providerOf(r) === provider && r.outcome === "done" && r.endedAt && r.weeklyBefore !== undefined && r.weeklyAfter !== undefined,
  );
  const fallback = config.estimates[size];
  if (done.length < 3) return { ...fallback, basis: "default" };
  const pct = median(done.map((r) => Math.max(0, r.weeklyAfter! - r.weeklyBefore!)))!;
  const minutes = median(done.map((r) => (r.endedAt! - r.startedAt) / 60_000))!;
  return { pct: Math.max(0.1, Math.round(pct * 10) / 10), minutes: Math.round(minutes), basis: "history" };
}

/** True if a task may run on this plan: the plan is enabled, and the task isn't pinned to another. */
export function runsOn(t: Pick<Task, "engine">, provider: Provider, engines: readonly Provider[]): boolean {
  return engines.includes(provider) && (!t.engine || t.engine === provider);
}

/** The next task to run on a plan: the first queued one, in order, whose estimate fits the budget. */
export function pickNext(
  tasks: Task[],
  available: number,
  runs: Run[],
  config: Pick<Config, "estimates"> & Partial<Pick<Config, "engines">>,
  provider: Provider = "claude",
): Task | undefined {
  const engines = config.engines ?? ["claude"];
  return tasks
    .filter((t) => t.status === "queued" && runsOn(t, provider, engines))
    .sort(compareTasks)
    .find((t) => estimate(t.size, runs, config, provider).pct <= available);
}

/** Weekly % the queue spent on one plan since `since` within the given weekly window. */
export function queueSpentSince(runs: Run[], since: number, weeklyResetsAt: number, provider: Provider = "claude"): number {
  return runs
    .filter(
      (r) =>
        providerOf(r) === provider &&
        r.startedAt >= since &&
        r.weeklyBefore !== undefined &&
        r.weeklyAfter !== undefined &&
        (r.weeklyResetsAt === undefined || Math.abs(r.weeklyResetsAt - weeklyResetsAt) < 3_600_000),
    )
    .reduce((sum, r) => sum + Math.max(0, r.weeklyAfter! - r.weeklyBefore!), 0);
}
