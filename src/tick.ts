import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { computeBudget, type Budget } from "./budget.js";
import { loadConfig, type Config } from "./config.js";
import { paths } from "./paths.js";
import { loadPresence, osIdleMs, resolvePresence, type Presence } from "./presence.js";
import { probeUsage, runTask } from "./runner.js";
import { log } from "./store.js";
import { compareTasks, estimate, loadRuns, loadTasks, newId, pickNext, queueSpentSince, runsOn, saveRuns, saveTasks, type Run, type Task } from "./tasks.js";
import { startOfLocalDay } from "./time.js";
import { latest, loadSnapshots, PROVIDER_NAMES, readCodexUsage, recordSnapshot, weeklyAtDayStart, type Provider, type Window } from "./usage.js";

export interface State {
  /** Whose plan these numbers are for. */
  provider: Provider;
  config: Config;
  weekly?: Window & { at: number };
  fiveHour?: Window & { at: number };
  budget?: Budget;
  presence: Presence;
}

/** Everything `status` and `tick` need for one plan, computed from what's on disk. */
export function currentState(now = Date.now(), opts: { idle?: boolean; provider?: Provider } = {}): State {
  const provider = opts.provider ?? "claude";
  const config = loadConfig();
  if (provider === "codex") {
    // Codex writes its usage into its own session logs; pick up the newest one.
    const reading = readCodexUsage(now);
    if (reading) recordSnapshot(reading);
  }
  const snaps = loadSnapshots(provider);
  let { weekly, fiveHour } = latest(snaps);
  // Claude Code drops a window once its reset passes; do the same.
  if (weekly && weekly.resetsAt <= now) weekly = undefined;
  if (fiveHour && fiveHour.resetsAt <= now) fiveHour = undefined;
  const presence = resolvePresence(loadPresence(), config.presence.idleMinutes, now, opts.idle === false ? undefined : osIdleMs());
  if (!weekly) return { provider, config, fiveHour, presence };

  const dayStart = startOfLocalDay(now, config.timezone);
  const budget = computeBudget({
    now,
    config,
    weeklyPct: weekly.pct,
    resetsAt: weekly.resetsAt,
    dayStartPct: weeklyAtDayStart(snaps, now, config.timezone, weekly),
    queueSpentToday: queueSpentSince(loadRuns(), dayStart, weekly.resetsAt, provider),
  });
  return { provider, config, weekly, fiveHour, budget, presence };
}

export interface Decision {
  run: boolean;
  task?: Task;
  why: string;
}

/** Should the queue start a task on this plan right now, and which one? */
export function decide(state: State, tasks: Task[], runs: Run[]): Decision {
  const { config, budget, fiveHour, presence, provider } = state;
  const queued = tasks.filter((t) => t.status === "queued" && runsOn(t, provider, config.engines));
  if (queued.length === 0) return { run: false, why: "queue is empty" };
  if (!budget) return { run: false, why: "no weekly usage reading yet" };
  const fiveMax = presence.effective === "away" ? config.fiveHour.maxWhileAway : config.fiveHour.maxWhileActive;
  if (fiveHour && fiveHour.pct >= fiveMax) {
    return { run: false, why: `5-hour window at ${fiveHour.pct.toFixed(0)}%, limit while ${presence.effective} is ${fiveMax}%` };
  }
  if (budget.available <= 0) return { run: false, why: "no budget left after reserves and cap" };
  const task = pickNext(tasks, budget.available, runs, config, provider);
  if (!task) return { run: false, why: `${budget.available}% available, smaller than every queued task's estimate` };
  return { run: true, task, why: `${budget.available}% available, you're ${presence.effective}` };
}

/** Plans the queue may spend, as configured (Claude if the list is empty or broken). */
export function enginesOf(config: Config): Provider[] {
  return config.engines?.length ? config.engines : ["claude"];
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
    const engines = enginesOf(config);
    const multi = engines.length > 1;
    for (let n = 0; n < maxTasks; n++) {
      // Ask each plan what it would run, then start the task that comes first in the queue.
      const options: { state: State; d: Decision }[] = [];
      const reasons: string[] = [];
      for (const provider of engines) {
        let state = currentState(Date.now(), { provider });
        const stale = !state.weekly || Date.now() - state.weekly.at > config.run.staleMinutes * 60_000;
        const anyQueued = loadTasks().some((t) => t.status === "queued" && runsOn(t, provider, engines));
        if (stale && anyQueued && !opts.dryRun) {
          say(`${PROVIDER_NAMES[provider]} usage reading is stale; probing`);
          const snap = await probeUsage(config, provider);
          if (!snap) say(`${PROVIDER_NAMES[provider]} probe returned no usage reading`);
          state = currentState(Date.now(), { provider });
        }
        const d = decide(state, loadTasks(), loadRuns());
        if (d.run && d.task) options.push({ state, d });
        else reasons.push(multi ? `${PROVIDER_NAMES[provider]}: ${d.why}` : d.why);
      }
      const pick = options.sort((a, b) => compareTasks(a.d.task!, b.d.task!))[0];
      if (!pick) {
        say(`not running: ${reasons.join("; ")}`);
        break;
      }
      const { state, d } = pick;
      const task = d.task!;
      const est = estimate(task.size, loadRuns(), config, state.provider);
      const on = multi ? ` on ${PROVIDER_NAMES[state.provider]}` : "";
      say(`${opts.dryRun ? "would run" : "running"} ${task.id} "${task.title}"${on} (est. ${est.pct}%, ~${est.minutes} min): ${d.why}`);
      if (opts.dryRun) break;

      const outcome = await runOne(task.id, state, config);
      if (outcome === "limit") {
        say(`hit a ${PROVIDER_NAMES[state.provider]} usage limit; the task goes back in the queue`);
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
    provider: state.provider,
    startedAt: Date.now(),
    weeklyBefore: state.weekly?.pct,
    weeklyResetsAt: state.weekly?.resetsAt,
  };
  saveRuns([...loadRuns(), run]);

  const result = await runTask(task, run.id, config, state.provider).catch((e: Error) => ({ outcome: "failed" as const, note: e.message, lastSnapshot: undefined, result: undefined }));

  // The weekly % after the run is the newest reading in the same window.
  const after = currentState(Date.now(), { idle: false, provider: state.provider }).weekly;
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
