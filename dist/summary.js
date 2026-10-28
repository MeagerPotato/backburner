import { estimate, loadRuns, loadTasks, runsOn } from "./tasks.js";
import { currentState, decide, enginesOf } from "./tick.js";
import { PROVIDER_NAMES } from "./usage.js";
const round = (n) => Math.round(n * 10) / 10;
function engineSummary(provider, now, opts, tasks, runs) {
    const s = currentState(now, { ...opts, provider });
    const d = decide(s, tasks, runs);
    const queued = tasks.filter((t) => t.status === "queued" && runsOn(t, provider, s.config.engines));
    const b = s.budget;
    const engine = {
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
export function summary(now = Date.now(), opts = {}) {
    const tasks = loadTasks();
    const runs = loadRuns();
    const first = engineSummary("claude", now, opts, tasks, runs);
    const engines = enginesOf(first.state.config);
    const all = engines.map((p) => (p === "claude" ? first.engine : engineSummary(p, now, opts, tasks, runs).engine));
    const main = all.find((e) => e.provider === "claude") ?? all[0];
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
