import { randomBytes } from "node:crypto";
import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { providerOf } from "./usage.js";
export const newId = () => randomBytes(3).toString("hex");
export function loadTasks() {
    return readJson(paths.tasks(), []);
}
export function saveTasks(tasks) {
    writeJson(paths.tasks(), tasks);
}
export function loadRuns() {
    return readJson(paths.runs(), []);
}
export function saveRuns(runs) {
    writeJson(paths.runs(), runs.slice(-500));
}
export function findTask(tasks, idOrPrefix) {
    const matches = tasks.filter((t) => t.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
}
export function titleFrom(prompt) {
    const line = prompt.trim().split(/\r?\n/)[0] ?? "";
    return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}
const deadlineMs = (t) => (t.deadline ? Date.parse(t.deadline) : Number.POSITIVE_INFINITY);
/** Earliest deadline first, then higher priority, then oldest. */
export function compareTasks(a, b) {
    return deadlineMs(a) - deadlineMs(b) || b.priority - a.priority || a.createdAt - b.createdAt;
}
function median(xs) {
    if (xs.length === 0)
        return undefined;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/**
 * Estimate from your own finished runs of the same size on the same plan, or the
 * configured defaults. Plans differ in size, so a Codex run says nothing about Claude.
 */
export function estimate(size, runs, config, provider = "claude") {
    const done = runs.filter((r) => r.size === size && providerOf(r) === provider && r.outcome === "done" && r.endedAt && r.weeklyBefore !== undefined && r.weeklyAfter !== undefined);
    const fallback = config.estimates[size];
    if (done.length < 3)
        return { ...fallback, basis: "default" };
    const pct = median(done.map((r) => Math.max(0, r.weeklyAfter - r.weeklyBefore)));
    const minutes = median(done.map((r) => (r.endedAt - r.startedAt) / 60_000));
    return { pct: Math.max(0.1, Math.round(pct * 10) / 10), minutes: Math.round(minutes), basis: "history" };
}
/** True if a task may run on this plan: the plan is enabled, and the task isn't pinned to another. */
export function runsOn(t, provider, engines) {
    return engines.includes(provider) && (!t.engine || t.engine === provider);
}
/** The next task to run on a plan: the first queued one, in order, whose estimate fits the budget. */
export function pickNext(tasks, available, runs, config, provider = "claude") {
    const engines = config.engines ?? ["claude"];
    return tasks
        .filter((t) => t.status === "queued" && runsOn(t, provider, engines))
        .sort(compareTasks)
        .find((t) => estimate(t.size, runs, config, provider).pct <= available);
}
/** Weekly % the queue spent on one plan since `since` within the given weekly window. */
export function queueSpentSince(runs, since, weeklyResetsAt, provider = "claude") {
    return runs
        .filter((r) => providerOf(r) === provider &&
        r.startedAt >= since &&
        r.weeklyBefore !== undefined &&
        r.weeklyAfter !== undefined &&
        (r.weeklyResetsAt === undefined || Math.abs(r.weeklyResetsAt - weeklyResetsAt) < 3_600_000))
        .reduce((sum, r) => sum + Math.max(0, r.weeklyAfter - r.weeklyBefore), 0);
}
