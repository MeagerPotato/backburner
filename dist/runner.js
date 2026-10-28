import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import { log } from "./store.js";
import { isRejection, parseStreamEvent, recordSnapshot } from "./usage.js";
const isWin = process.platform === "win32";
function quote(arg) {
    if (!/[\s"&|<>^()]/.test(arg))
        return arg;
    return `"${arg.replace(/"/g, '""')}"`;
}
/**
 * How to start a command. On Windows, an npm `.cmd` shim (or a bare name that may
 * resolve to one) only starts through cmd.exe; an `.exe` starts directly. When a shell
 * is needed, the command line is joined here rather than handing Node an args array
 * with `shell: true`, which Node 24 warns about (DEP0190).
 */
export function launch(cmd, args) {
    if (!isWin || /\.(exe|com)$/i.test(cmd))
        return { file: cmd, args, shell: false };
    return { file: [cmd, ...args].map(quote).join(" "), args: [], shell: true };
}
/**
 * Runs the unmodified `claude` CLI headless. The prompt goes in on stdin so no shell
 * quoting can mangle it. Usage readings from the stream are saved as they arrive.
 */
export function runClaude(opts) {
    // dontAsk denies any tool not on the allow list instead of waiting for an answer.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk"];
    if (opts.allow.length)
        args.push("--allowedTools", ...opts.allow);
    const model = opts.model ?? opts.config.run.model;
    if (model)
        args.push("--model", model);
    return new Promise((resolve) => {
        const cmd = launch(opts.config.run.claudePath, args);
        const child = spawn(cmd.file, cmd.args, {
            cwd: opts.cwd,
            shell: cmd.shell,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const out = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : undefined;
        const state = { code: null, isError: false, rejected: false, timedOut: false };
        let buf = "";
        let stopped = false;
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                state.timedOut = true;
                child.kill();
            }, opts.timeoutMs)
            : undefined;
        const onLine = (line) => {
            if (!line.trim())
                return;
            out?.write(line + "\n");
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                return;
            }
            const snap = parseStreamEvent(event);
            if (snap) {
                recordSnapshot(snap);
                state.lastSnapshot = snap;
                if (opts.stopAfterUsage && !stopped) {
                    stopped = true;
                    child.kill();
                }
            }
            if (isRejection(event))
                state.rejected = true;
            const e = event;
            if (e.type === "result") {
                state.text = typeof e.result === "string" ? e.result : undefined;
                state.isError = Boolean(e.is_error);
            }
        };
        child.stdout.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                onLine(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
            }
        });
        child.stderr.on("data", (chunk) => out?.write(`[stderr] ${chunk.toString("utf8")}`));
        child.on("error", (err) => {
            log(`could not start claude: ${err.message}`);
            state.isError = true;
            state.text = `Could not start "${opts.config.run.claudePath}": ${err.message}`;
        });
        child.on("close", (code) => {
            if (buf)
                onLine(buf);
            if (timer)
                clearTimeout(timer);
            out?.end();
            state.code = code;
            resolve(state);
        });
        child.stdin.end(opts.prompt);
    });
}
/** Fetch fresh usage numbers. Stops Claude the moment the first reading arrives. */
export async function probeUsage(config) {
    mkdirSync(paths.results(), { recursive: true });
    const run = await runClaude({
        config,
        prompt: "Reply with the single word: ok",
        cwd: paths.results(),
        allow: [],
        model: "haiku",
        timeoutMs: 120_000,
        stopAfterUsage: true,
    });
    if (run.lastSnapshot)
        return { ...run.lastSnapshot, source: "probe" };
    return undefined;
}
const LIMIT_TEXT = /usage limit|rate limit|limit reached|limit will reset|resets at/i;
function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}
function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hasCommand(cmd) {
    try {
        const c = launch(cmd, ["--version"]);
        execFileSync(c.file, c.args, { stdio: "ignore", windowsHide: true, shell: c.shell });
        return true;
    }
    catch {
        return false;
    }
}
const RESEARCH_PREAMBLE = `You are running unattended from a task queue. Nobody is watching, so don't ask questions; make reasonable assumptions and state them. Do the task below and finish with a clear written report.

Task:
`;
function codePreamble(branch) {
    return `You are running unattended from a task queue in a git worktree on branch "${branch}". Nobody is watching, so don't ask questions; make reasonable assumptions and note them. Do the task below by editing files in this folder. Don't run git commands: Backburner commits your changes to this branch when you finish. Finish with a short summary of what you changed and anything left to do.

Task:
`;
}
export async function runTask(task, runId, config) {
    const dir = join(paths.results(), task.id);
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, `${runId}.jsonl`);
    const timeoutMs = config.run.timeoutMinutes * 60_000;
    if (task.mode === "research") {
        const run = await runClaude({ config, prompt: RESEARCH_PREAMBLE + task.prompt, cwd: task.dir, allow: config.run.researchTools, logFile, timeoutMs });
        const outcome = classify(run);
        const report = join(dir, `${runId}.md`);
        writeFileSync(report, `# ${task.title}\n\n${run.text ?? "(no output)"}\n`);
        return { outcome, text: run.text, lastSnapshot: run.lastSnapshot, result: report };
    }
    // Coding task: work in a fresh worktree on its own branch, never on your checkout.
    if (!existsSync(join(task.dir, ".git")) && !safeIsRepo(task.dir)) {
        return { outcome: "failed", note: `${task.dir} is not a git repo` };
    }
    const branch = `backburner/${slug(task.title)}-${task.id}`;
    const tree = join(paths.worktrees(), `${task.id}-${runId}`);
    try {
        git(task.dir, ["worktree", "add", "-b", branch, tree]);
    }
    catch (e) {
        return { outcome: "failed", note: `git worktree add failed: ${e.message}` };
    }
    const base = safe(() => git(tree, ["rev-parse", "HEAD"]));
    const run = await runClaude({ config, prompt: codePreamble(branch) + task.prompt, cwd: tree, allow: config.run.codeTools, logFile, timeoutMs });
    const outcome = classify(run);
    writeFileSync(join(dir, `${runId}.md`), `# ${task.title}\n\nBranch: ${branch}\n\n${run.text ?? "(no output)"}\n`);
    commitAll(tree, task);
    let result = `branch ${branch}`;
    let note;
    const commits = base ? Number(safe(() => git(tree, ["rev-list", "--count", `${base}..HEAD`])) ?? 0) : 0;
    if (commits === 0) {
        note = "no commits were made";
    }
    else if (config.run.openDraftPr && safe(() => git(tree, ["remote", "get-url", "origin"])) && hasCommand("gh")) {
        try {
            git(tree, ["push", "-u", "origin", branch]);
            const body = `Opened by Backburner from a queued task.\n\n${(run.text ?? "").slice(0, 4000)}`;
            const url = execFileSync("gh", ["pr", "create", "--draft", "--title", task.title, "--body", body, "--head", branch], {
                cwd: tree,
                encoding: "utf8",
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            result = url;
        }
        catch (e) {
            note = `pushed nothing or PR failed: ${e.message.split("\n")[0]}`;
        }
    }
    // The branch keeps the work; the worktree folder isn't needed afterwards.
    safe(() => git(task.dir, ["worktree", "remove", "--force", tree]));
    return { outcome, text: run.text, lastSnapshot: run.lastSnapshot, result, note };
}
/** Commit whatever the run changed. Falls back to a Backburner identity if git has none set. */
function commitAll(tree, task) {
    if (!safe(() => git(tree, ["status", "--porcelain"])))
        return;
    git(tree, ["add", "-A"]);
    const msg = `${task.title}\n\nQueued task ${task.id}, run unattended by Backburner.`;
    try {
        git(tree, ["commit", "-q", "-m", msg]);
    }
    catch {
        safe(() => git(tree, ["-c", "user.name=Backburner", "-c", "user.email=backburner@localhost", "commit", "-q", "-m", msg]));
    }
}
function classify(run) {
    if (run.timedOut)
        return "timeout";
    if (run.rejected || (run.isError && LIMIT_TEXT.test(run.text ?? "")))
        return "limit";
    if (run.isError || (run.code !== 0 && run.code !== null))
        return "failed";
    return "done";
}
function safe(fn) {
    try {
        return fn();
    }
    catch {
        return undefined;
    }
}
function safeIsRepo(dir) {
    return safe(() => git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
}
