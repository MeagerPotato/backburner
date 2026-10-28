import { estimate, loadRuns, loadTasks } from "./tasks.js";
import { currentState, decide } from "./tick.js";
export function summary(now = Date.now(), opts = {}) {
    const s = currentState(now, opts);
    const tasks = loadTasks();
    const runs = loadRuns();
    const d = decide(s, tasks, runs);
    const queued = tasks.filter((t) => t.status === "queued");
    const b = s.budget;
    const round = (n) => Math.round(n * 10) / 10;
    return {
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
        presence: s.presence,
        queued: queued.length,
        queuedPct: round(queued.reduce((sum, t) => sum + estimate(t.size, runs, s.config).pct, 0)),
        next: { run: d.run, taskId: d.task?.id, title: d.task?.title, why: d.why },
        guard: s.config.guard,
        timezone: s.config.timezone,
    };
}
