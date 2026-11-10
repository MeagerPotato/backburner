import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { findTask, loadTasks, saveTasks } from "./tasks.js";
const SIZES = ["small", "medium", "large"];
const noMatch = (id) => ({ ok: false, error: `No single task matches "${id}".` });
export function updateTask(id, c) {
    const tasks = loadTasks();
    const t = findTask(tasks, id);
    if (!t)
        return noMatch(id);
    if (t.status !== "queued")
        return { ok: false, error: `${t.id} is ${t.status}, so it can't be edited. Retry it to queue it again first.` };
    const next = { ...t };
    if (c.prompt?.trim())
        next.prompt = c.prompt.trim();
    if (c.title?.trim())
        next.title = c.title.trim();
    if (c.mode) {
        if (c.mode !== "research" && c.mode !== "code")
            return { ok: false, error: "mode must be research or code." };
        next.mode = c.mode;
    }
    if (c.dir?.trim()) {
        if (!isAbsolute(c.dir.trim()))
            return { ok: false, error: "dir must be an absolute path." };
        next.dir = resolve(c.dir.trim());
    }
    if (next.mode === "code" && t.mode !== "code" && !c.dir?.trim()) {
        return { ok: false, error: "Coding tasks need dir: the absolute path of the git repository." };
    }
    if (c.priority !== undefined) {
        if (!Number.isInteger(c.priority) || c.priority < 1 || c.priority > 5)
            return { ok: false, error: "priority must be 1 to 5." };
        next.priority = c.priority;
    }
    if (c.deadline !== undefined) {
        const d = c.deadline.trim();
        if (d && Number.isNaN(Date.parse(d)))
            return { ok: false, error: "deadline must be a date like 2026-11-02." };
        next.deadline = d || undefined;
    }
    if (c.size !== undefined) {
        if (!SIZES.includes(c.size))
            return { ok: false, error: "size must be small, medium or large." };
        next.size = c.size;
    }
    if (c.engine !== undefined) {
        const e = c.engine.trim().toLowerCase();
        if (!["claude", "codex", "any", ""].includes(e))
            return { ok: false, error: "engine must be claude, codex or any." };
        next.engine = e === "claude" || e === "codex" ? e : undefined;
    }
    Object.assign(t, next);
    saveTasks(tasks);
    return { ok: true, task: t };
}
export function retryTask(id) {
    const tasks = loadTasks();
    const t = findTask(tasks, id);
    if (!t)
        return noMatch(id);
    if (t.status === "queued" || t.status === "running")
        return { ok: false, error: `${t.id} is already ${t.status}.` };
    t.status = "queued";
    t.attempts = 0;
    t.note = undefined;
    saveTasks(tasks);
    return { ok: true, task: t };
}
export function cancelTask(id) {
    const tasks = loadTasks();
    const t = findTask(tasks, id);
    if (!t)
        return noMatch(id);
    if (t.status === "running")
        return { ok: false, error: `${t.id} is running right now. It will finish or time out on its own.` };
    t.status = "cancelled";
    saveTasks(tasks);
    return { ok: true, task: t };
}
const MAX_RESULT_CHARS = 40_000;
/** A finished task's report text, or where its result lives. */
export function readResult(id, max = MAX_RESULT_CHARS) {
    const t = findTask(loadTasks(), id);
    if (!t)
        return { ok: false, error: `No single task matches "${id}".` };
    const note = t.note ? ` (note: ${t.note})` : "";
    if (!t.result) {
        if (t.status === "queued" || t.status === "running")
            return { ok: true, text: `${t.id} hasn't finished yet (${t.status}).` };
        return { ok: true, text: `${t.id} is ${t.status} with no result.${note}` };
    }
    if (!isAbsolute(t.result) || !existsSync(t.result) || !statSync(t.result).isFile())
        return { ok: true, text: `${t.title}: ${t.result}${note}` };
    const body = readFileSync(t.result, "utf8");
    const cut = body.length > max ? `${body.slice(0, max)}\n\n[Truncated. Full report: ${t.result}]` : body;
    return { ok: true, text: `Report for ${t.id} (${t.result}):\n\n${cut}` };
}
