import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { computeBudget, type Budget } from "./budget.js";
import { loadConfig, type Config } from "./config.js";
import { paths } from "./paths.js";
import { loadPresence, osIdleMs, resolvePresence, type Presence } from "./presence.js";
import { probeUsage, runTask } from "./runner.js";
import { log } from "./store.js";
import { estimate, loadRuns, loadTasks, newId, pickNext, queueSpentSince, saveRuns, saveTasks, type Run, type Task } from "./tasks.js";
import { startOfLocalDay } from "./time.js";
import { latest, loadSnapshots, weeklyAtDayStart, type Window } from "./usage.js";

export interface State {
  config: Config;
  weekly?: Window & { at: number };
  fiveHour?: Window & { at: number };
  budget?: Budget;
  presence: Presence;
}

/** Everything `status` and `tick` need, computed from what's on disk. */
export function currentState(now = Date.now(), opts: { idle?: boolean } = {}): State {
  const config = loadConfig();
  const snaps = loadSnapshots();
  let { weekly, fiveHour } = latest(snaps);
  // Claude Code drops a window once its reset passes; do the same.
  if (weekly && weekly.resetsAt <= now) weekly = undefined;
  if (fiveHour && fiveHour.resetsAt <= now) fiveHour = undefined;
  const presence = resolvePresence(loadPresence(), config.presence.idleMinutes, now, opts.idle === false ? undefined : osIdleMs());
  if (!weekly) return { config, fiveHour, presence };

  const dayStart = startOfLocalDay(now, config.timezone);
  const budget = computeBudget({
    now,
    config,
    weeklyPct: weekly.pct,
    resetsAt: weekly.resetsAt,
    dayStartPct: weeklyAtDayStart(snaps, now, config.timezone, weekly),
    queueSpentToday: queueSpentSince(loadRuns(), dayStart, weekly.resetsAt),
  });
  return { config, weekly, fiveHour, budget, presence };
}

export interface Decision {
  run: boolean;
  task?: Task;
  why: string;
}

/** Should the queue start a task right now, and which one? */
export function decide(state: State, tasks: Task[], runs: Run[]): Decision {
  const { config, budget, fiveHour, presence } = state;
  if (!budget) return { run: false, why: "no weekly usage reading yet" };
  const fiveMax = presence.effective === "away" ? config.fiveHour.maxWhileAway : config.fiveHour.maxWhileActive;
  if (fiveHour && fiveHour.pct >= fiveMax) {
    return { run: false, why: `5-hour window at ${fiveHour.pct.toFixed(0)}%, limit while ${presence.effective} is ${fiveMax}%` };
  }
  const queued = tasks.filter((t) => t.status === "queued");
  if (queued.length === 0) return { run: false, why: "queue is empty" };
  if (budget.available <= 0) return { run: false, why: "no budget left after reserves and cap" };
  const task = pickNext(tasks, budget.available, runs, config);
  if (!task) return { run: false, why: `${budget.available}% available, smaller than every queued task's estimate` };
  return { run: true, task, why: `${budget.available}% available, you're ${presence.effective}` };
}

// ---------- locking ----------

function acquireLock(staleMs: number): boolean {
  try {
    const fd = openSync(paths.lock(), "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(paths.lock()).mtimeMs > staleMs) {
        log(`removing stale lock held by pid ${readFileSync(paths.lock(), "utf8")}`);
        unlinkSync(paths.lock());
        return acquireLock(staleMs);
      }
    } catch {
      // Lock vanished between checks; try once more.
      return acquireLock(staleMs);
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    unlinkSync(paths.lock());
  } catch {
    // Already gone.
  }
}

/**
 * One scheduler pass. Refreshes usage if it's stale, then keeps starting tasks while
 * the budget and the 5-hour window allow. Safe to call every few minutes.
 */
export async function tick(opts: { dryRun?: boolean; maxTasks?: number } = {}): Promise<string[]> {
  const out: string[] = [];
  const say = (m: string) => {
    out.push(m);
    log(m);
  };
  const config = loadConfig();
  if (!opts.dryRun && !acquireLock((config.run.timeoutMinutes + 15) * 60_000)) {
    say("another tick is running; skipping");
    return out;
  }
  try {
    const maxTasks = opts.maxTasks ?? 10;
    for (let n = 0; n < maxTasks; n++) {
      let state = currentState();
      const stale = !state.weekly || Date.now() - state.weekly.at > config.run.staleMinutes * 60_000;
      const anyQueued = loadTasks().some((t) => t.status === "queued");
      if (stale && anyQueued && !opts.dryRun) {
        say("usage reading is stale; probing");
        const snap = await probeUsage(config);
        if (!snap) say("probe returned no usage reading");
        state = currentState();
      }

      const tasks = loadTasks();
      const runs = loadRuns();
      const d = decide(state, tasks, runs);
      if (!d.run || !d.task) {
        say(`not running: ${d.why}`);
        break;
      }
      const est = estimate(d.task.size, runs, config);
      say(`${opts.dryRun ? "would run" : "running"} ${d.task.id} "${d.task.title}" (est. ${est.pct}%, ~${est.minutes} min): ${d.why}`);
      if (opts.dryRun) break;

      const outcome = await runOne(d.task.id, state, config);
      if (outcome === "limit") {
        say("hit a usage limit; the task goes back in the queue");
        break;
      }
    }
  } finally {
    if (!opts.dryRun) releaseLock();
  }
  return out;
}

async function runOne(taskId: string, state: State, config: Config): Promise<Run["outcome"]> {
  let tasks = loadTasks();
  const task = tasks.find((t) => t.id === taskId)!;
  task.status = "running";
  task.attempts += 1;
  saveTasks(tasks);

  const run: Run = {
    id: newId(),
    taskId,
    size: task.size,
    startedAt: Date.now(),
    weeklyBefore: state.weekly?.pct,
    weeklyResetsAt: state.weekly?.resetsAt,
  };
  saveRuns([...loadRuns(), run]);

  const result = await runTask(task, run.id, config).catch((e: Error) => ({ outcome: "failed" as const, note: e.message, lastSnapshot: undefined, result: undefined }));

  // The weekly % after the run is the newest reading in the same window.
  const after = currentState(Date.now(), { idle: false }).weekly;
  run.endedAt = Date.now();
  run.outcome = result.outcome;
  if (after && run.weeklyResetsAt && Math.abs(after.resetsAt - run.weeklyResetsAt) < 3_600_000) run.weeklyAfter = after.pct;
  saveRuns(loadRuns().map((r) => (r.id === run.id ? run : r)));

  tasks = loadTasks();
  const t = tasks.find((x) => x.id === taskId)!;
  t.result = result.result ?? t.result;
  t.note = result.note;
  if (result.outcome === "done") t.status = "done";
  else if (result.outcome === "limit") {
    // Not the task's fault: put it back and don't count the attempt.
    t.status = "queued";
    t.attempts = Math.max(0, t.attempts - 1);
  }
  else t.status = t.attempts >= 2 ? "failed" : "queued";
  saveTasks(tasks);
  log(`finished ${taskId}: ${result.outcome}${result.note ? ` (${result.note})` : ""}${result.result ? ` -> ${result.result}` : ""}`);
  return result.outcome;
}
