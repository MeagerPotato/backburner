#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig, setConfigValue, validate } from "./config.js";
import { initConfig, installDesktopMcp, installSchedule, pinClaudePath, uninstallDesktopMcp, uninstallSchedule, wireClaudeSettings, } from "./install.js";
import { AGENTS, disconnectAgent, findAgent } from "./agents.js";
import { cancelTask, readResult, retryTask, updateTask } from "./manage.js";
import { callTool, INSTRUCTIONS, serve, TOOLS } from "./mcp.js";
import { setupWizard } from "./setup.js";
import { paths } from "./paths.js";
import { setMode, touchActivity } from "./presence.js";
import { probeUsage } from "./runner.js";
import { readStdin, statusline } from "./statusline.js";
import { readFileSync } from "node:fs";
import { compareTasks, estimate, loadRuns, loadTasks, newId, saveTasks, titleFrom } from "./tasks.js";
import { tick } from "./tick.js";
import { summary } from "./summary.js";
import { parseStatusline, PROVIDER_NAMES, PROVIDERS, recordSnapshot } from "./usage.js";
import { WEEKDAYS } from "./time.js";
const HELP = `backburner: pace your Claude (and Codex) plan's weekly usage and spend the slack on queued tasks

Setup
  backburner setup                Find your agents, answer a few questions, install everything
  backburner init                 Create config, hook into Claude Code's status line
  backburner schedule install     Run the queue in the background every 10 minutes
  backburner schedule uninstall   Stop background runs
  backburner desktop install      Let regular Claude Desktop chats queue tasks (MCP server)
  backburner desktop uninstall    Remove it from Claude Desktop
  backburner agents               Which AI tools are on this computer, and which are connected
  backburner connect <agent>|--all    Give an agent Backburner's tools (codex, gemini, cursor, ...)
  backburner disconnect <agent>|--all Take them away again
  backburner uninstall            Disconnect every agent and stop the background schedule

Every day
  backburner status               Budget, reserves, presence and queue at a glance
  backburner add "<prompt>"       Queue a task
      --title <text>  --dir <path>  --code  --priority 1-5
      --deadline YYYY-MM-DD  --size small|medium|large
      --engine claude|codex|any  (default any: whichever plan has room)
  backburner list [--all]         Show queued (or all) tasks with estimates
  backburner edit <id> [options]  Change a queued task (same options as add, plus --prompt)
  backburner remove <id>          Cancel a task
  backburner retry <id>           Queue a failed, cancelled or finished task again
  backburner result <id>          Print a finished task's report, or its branch and PR
  backburner away | active | auto Set your presence (auto watches for idle time)

Settings
  backburner config               Print the config file
  backburner config set <key> <value>
      e.g. reserves.sat 2, weeklyCap 95, releaseHour 23, guard warn, engines claude,codex

Advanced
  backburner tick [--dry-run]     One scheduler pass (what the background job runs)
  backburner probe [claude|codex] Fetch fresh usage numbers now
  backburner log [-n 30]          Recent activity
`;
const fmtTime = (ms, tz) => new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
function fail(msg) {
    console.error(msg);
    process.exit(1);
}
function printStatus(json) {
    const sum = summary();
    if (json) {
        console.log(JSON.stringify(sum, null, 2));
        return;
    }
    const tz = sum.timezone;
    const multi = sum.engines.length > 1;
    for (const e of sum.engines) {
        if (multi)
            console.log(`${e.name}`);
        if (!e.weekly || !e.budget) {
            const how = e.provider === "codex" ? "Run Codex once (Backburner reads its session logs)" : "Open Claude Code once (the status line feeds Backburner)";
            console.log(`No weekly usage reading yet. ${how}, or run \`backburner probe${multi ? ` ${e.provider}` : ""}\`.`);
        }
        else {
            const b = e.budget;
            const age = Math.round((Date.now() - e.weekly.at) / 60_000);
            console.log(`Weekly usage    ${b.used}% of plan (read ${age} min ago), resets ${fmtTime(e.weekly.resetsAt, tz)}`);
            if (e.fiveHour)
                console.log(`5-hour window   ${e.fiveHour.pct.toFixed(0)}%, resets ${fmtTime(e.fiveHour.resetsAt, tz)}`);
            console.log(`Cap             ${b.cap}%`);
            console.log(`Today           reserve ${b.todayReserve}%, you've used ${b.personalToday}%, still held ${b.todayHeld}%${b.released ? " (released for tonight)" : ""}`);
            console.log(`Later days      ${b.futureHeld}% held${b.sweeping ? " (final sweep: all reserves freed)" : ""}`);
            console.log(`Queue budget    ${b.available}%`);
        }
        console.log(`Queue           ${e.queued} task(s), about ${e.queuedPct}% estimated`);
        console.log(`Next step       ${e.next.run ? `run ${e.next.taskId} "${e.next.title}"` : `wait (${e.next.why})`}`);
        if (multi)
            console.log("");
    }
    console.log(`Presence        ${sum.presence.effective} (${sum.presence.mode}: ${sum.presence.reason})`);
}
function parseEngine(v, engines) {
    if (v === undefined || v === "any")
        return undefined;
    if (!PROVIDERS.includes(v))
        fail("--engine must be claude, codex or any");
    if (!engines.includes(v))
        fail(`${PROVIDER_NAMES[v]} isn't enabled. Run \`backburner setup\`, or: backburner config set engines ${[...engines, v].join(",")}`);
    return v;
}
function printList(all, json) {
    const config = loadConfig();
    const runs = loadRuns();
    const tasks = loadTasks()
        .filter((t) => all || t.status === "queued" || t.status === "running")
        .sort(compareTasks);
    if (json) {
        const rows = tasks.map((t) => ({ ...t, estimate: estimate(t.size, runs, config, t.engine ?? config.engines[0]) }));
        return console.log(JSON.stringify(rows));
    }
    if (tasks.length === 0)
        return console.log(all ? "No tasks yet." : "Queue is empty. Add one with: backburner add \"...\"");
    for (const t of tasks) {
        const e = estimate(t.size, runs, config, t.engine ?? config.engines[0]);
        const due = t.deadline ? ` due ${t.deadline}` : "";
        const on = t.engine ? ` ${t.engine}` : "";
        console.log(`${t.id}  [${t.status}] P${t.priority} ${t.mode} ${t.size}${on} ~${e.pct}% ~${e.minutes}min${due}  ${t.title}`);
        if (t.result)
            console.log(`        -> ${t.result}`);
        if (t.note)
            console.log(`        note: ${t.note}`);
    }
}
async function main(argv) {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case undefined:
        case "help":
        case "--help":
        case "-h":
            console.log(HELP);
            return;
        case "setup": {
            await setupWizard();
            return;
        }
        case "init": {
            const { config: base, created } = initConfig();
            const { config, result } = wireClaudeSettings(base);
            saveConfig(config);
            console.log(`${created ? "Created" : "Kept"} config at ${paths.config()}`);
            console.log(`Time zone ${config.timezone}, reserves ${WEEKDAYS.map((d) => `${d} ${config.reserves[d]}%`).join(", ")}, cap ${config.weeklyCap}%`);
            if (result.changed) {
                console.log(`Updated ${result.settingsFile}${result.backup ? ` (backup: ${result.backup})` : ""}`);
                if (result.chained)
                    console.log(`Your old status line still runs first: ${result.chained}`);
            }
            else
                console.log("Claude Code settings already wired.");
            console.log(`Claude CLI: ${config.run.claudePath}`);
            console.log("\nNext: open Claude Code once so the status line records your usage, then run `backburner schedule install`.");
            return;
        }
        case "uninstall": {
            let config = loadConfig();
            for (const a of AGENTS) {
                const r = disconnectAgent(a, config);
                config = r.config;
                if (r.changed)
                    console.log(`Disconnected ${a.name}.`);
            }
            saveConfig(config);
            console.log(uninstallSchedule());
            console.log(`Your queue and settings are still in ${paths.config().replace(/[\\/]config\.json$/, "")}. Delete that folder to remove them too.`);
            return;
        }
        case "agents": {
            const config = loadConfig();
            for (const a of AGENTS) {
                const state = a.connected(config) ? "connected" : a.installed() ? "found, not connected" : "not found";
                console.log(`${a.id.padEnd(15)} ${a.name.padEnd(15)} ${state}`);
            }
            console.log(`\nQueue spends: ${config.engines.join(", ")}. Connect one with: backburner connect <id>`);
            return;
        }
        case "connect":
        case "disconnect": {
            const all = rest.includes("--all");
            const picked = all
                ? AGENTS.filter((a) => (cmd === "connect" ? a.installed() : true))
                : rest.map((id) => findAgent(id) ?? fail(`Unknown agent "${id}". Known: ${AGENTS.map((a) => a.id).join(", ")}`));
            if (picked.length === 0)
                fail(`Usage: backburner ${cmd} <agent>|--all   (agents: ${AGENTS.map((a) => a.id).join(", ")})`);
            let config = initConfig().config;
            for (const a of picked) {
                try {
                    if (cmd === "connect") {
                        const r = a.connect(config);
                        config = r.config;
                        console.log(r.message);
                    }
                    else {
                        const r = disconnectAgent(a, config);
                        config = r.config;
                        console.log(r.changed ? `Disconnected ${a.name}.` : `${a.name} wasn't connected.`);
                    }
                }
                catch (e) {
                    console.log(`${a.name}: ${e.message.split("\n")[0]}`);
                }
            }
            saveConfig(config);
            return;
        }
        case "desktop": {
            if (rest[0] === "install") {
                const { file, backup } = installDesktopMcp();
                console.log(`Added Backburner to ${file}${backup ? ` (backup: ${backup})` : ""}.`);
                console.log("Quit and reopen Claude Desktop, then ask Claude to queue something for Backburner.");
            }
            else if (rest[0] === "uninstall") {
                console.log(uninstallDesktopMcp() ? "Removed Backburner from Claude Desktop." : "Backburner wasn't in Claude Desktop's config.");
            }
            else
                fail("Usage: backburner desktop install|uninstall");
            return;
        }
        case "tools": {
            // For the Claude Code mod: the tools it registers, and the guidance Claude reads.
            console.log(JSON.stringify({ instructions: INSTRUCTIONS, tools: TOOLS }));
            return;
        }
        case "call": {
            // For the Claude Code mod: run one tool with JSON arguments on stdin.
            const name = rest[0];
            if (!name)
                fail("Usage: backburner call <tool> < args.json");
            const raw = (await readStdin()).trim();
            let args = {};
            try {
                args = raw ? JSON.parse(raw) : {};
            }
            catch {
                fail("call expects JSON arguments on stdin");
            }
            try {
                console.log(JSON.stringify(callTool(name, args)));
            }
            catch (e) {
                console.log(JSON.stringify({ content: [{ type: "text", text: `Backburner error: ${e.message}` }], isError: true }));
            }
            return;
        }
        case "mcp": {
            await serve();
            return;
        }
        case "schedule": {
            if (rest[0] === "install") {
                saveConfig(pinClaudePath(loadConfig()));
                console.log(installSchedule());
            }
            else if (rest[0] === "uninstall")
                console.log(uninstallSchedule());
            else
                fail("Usage: backburner schedule install|uninstall");
            return;
        }
        case "status": {
            printStatus(rest.includes("--json"));
            return;
        }
        case "add": {
            const { values, positionals } = parseArgs({
                args: rest,
                allowPositionals: true,
                options: {
                    title: { type: "string" },
                    dir: { type: "string" },
                    code: { type: "boolean" },
                    priority: { type: "string" },
                    deadline: { type: "string" },
                    size: { type: "string" },
                    engine: { type: "string" },
                },
            });
            const prompt = positionals.join(" ").trim();
            if (!prompt)
                fail('Usage: backburner add "<what Claude should do>" [--code] [--priority 1-5] [--deadline YYYY-MM-DD] [--size small|medium|large]');
            const priority = values.priority ? Number(values.priority) : 3;
            if (!Number.isInteger(priority) || priority < 1 || priority > 5)
                fail("--priority must be 1 to 5");
            const size = (values.size ?? "medium");
            if (!["small", "medium", "large"].includes(size))
                fail("--size must be small, medium or large");
            if (values.deadline && Number.isNaN(Date.parse(values.deadline)))
                fail("--deadline must be a date like 2026-10-30");
            const config = loadConfig();
            const engine = parseEngine(values.engine, config.engines);
            const task = {
                id: newId(),
                title: values.title ?? titleFrom(prompt),
                prompt,
                dir: resolve(values.dir ?? process.cwd()),
                mode: values.code ? "code" : "research",
                priority,
                deadline: values.deadline,
                size,
                ...(engine ? { engine } : {}),
                status: "queued",
                createdAt: Date.now(),
                attempts: 0,
            };
            saveTasks([...loadTasks(), task]);
            const e = estimate(size, loadRuns(), config, engine ?? config.engines[0]);
            const on = engine ? `, ${PROVIDER_NAMES[engine]}` : "";
            console.log(`Queued ${task.id}: ${task.title} (${task.mode}${on}, ~${e.pct}%, ~${e.minutes} min)`);
            return;
        }
        case "list": {
            printList(rest.includes("--all"), rest.includes("--json"));
            return;
        }
        case "remove":
        case "cancel": {
            const r = cancelTask(rest[0] ?? "");
            if (!r.ok)
                fail(r.error);
            console.log(`Cancelled ${r.task.id}: ${r.task.title}`);
            return;
        }
        case "edit": {
            const { values, positionals } = parseArgs({
                args: rest,
                allowPositionals: true,
                options: {
                    prompt: { type: "string" },
                    title: { type: "string" },
                    dir: { type: "string" },
                    code: { type: "boolean" },
                    research: { type: "boolean" },
                    priority: { type: "string" },
                    deadline: { type: "string" },
                    size: { type: "string" },
                    engine: { type: "string" },
                },
            });
            if (!positionals[0])
                fail("Usage: backburner edit <id> [--prompt <text>] [--title <text>] [--priority 1-5] [--deadline YYYY-MM-DD|\"\"] [--size small|medium|large] [--engine claude|codex|any] [--code --dir <path> | --research]");
            const r = updateTask(positionals[0], {
                prompt: values.prompt,
                title: values.title,
                mode: values.code ? "code" : values.research ? "research" : undefined,
                dir: values.dir ? resolve(values.dir) : undefined,
                priority: values.priority === undefined ? undefined : Number(values.priority),
                deadline: values.deadline,
                size: values.size,
                engine: values.engine,
            });
            if (!r.ok)
                fail(r.error);
            console.log(`Updated ${r.task.id}: ${r.task.title} (P${r.task.priority} ${r.task.mode} ${r.task.size}${r.task.deadline ? ` due ${r.task.deadline}` : ""})`);
            return;
        }
        case "retry": {
            const r = retryTask(rest[0] ?? "");
            if (!r.ok)
                fail(r.error);
            console.log(`Queued again ${r.task.id}: ${r.task.title}`);
            return;
        }
        case "result": {
            const r = readResult(rest[0] ?? "", Number.POSITIVE_INFINITY);
            if (!r.ok)
                fail(r.error);
            console.log(r.text);
            return;
        }
        case "away":
        case "active":
        case "auto": {
            setMode(cmd);
            console.log(`Presence set to ${cmd}.`);
            return;
        }
        case "config": {
            if (rest[0] === "set") {
                const [, key, ...value] = rest;
                if (!key || value.length === 0)
                    fail("Usage: backburner config set <key> <value>");
                const next = setConfigValue(loadConfig(), key, value.join(" "));
                const errors = validate(next);
                if (errors.length)
                    fail(errors.join("\n"));
                saveConfig(next);
                console.log(`Set ${key}.`);
            }
            else
                console.log(JSON.stringify(loadConfig(), null, 2));
            return;
        }
        case "tick": {
            for (const line of await tick({ dryRun: rest.includes("--dry-run") }))
                console.log(line);
            return;
        }
        case "probe": {
            const config = loadConfig();
            const which = rest[0] ? [parseEngine(rest[0], PROVIDERS) ?? "claude"] : config.engines;
            let failed = false;
            for (const p of which) {
                const snap = await probeUsage(config, p);
                if (!snap) {
                    failed = true;
                    const hint = p === "codex" ? "Is Codex installed and signed in with a ChatGPT plan?" : "Is Claude Code installed and signed in with a Pro or Max plan?";
                    console.error(`${PROVIDER_NAMES[p]}: couldn't read usage. ${hint}`);
                    continue;
                }
                console.log(`${which.length > 1 ? `${PROVIDER_NAMES[p]}: ` : ""}Weekly ${snap.weekly?.pct.toFixed(1) ?? "?"}%, 5-hour ${snap.fiveHour?.pct.toFixed(1) ?? "?"}%`);
            }
            if (failed)
                process.exit(1);
            return;
        }
        case "ingest": {
            // Called by the Claude Code mod: usage in the status line's JSON shape on stdin, summary out.
            const raw = await readStdin();
            try {
                const snap = parseStatusline(JSON.parse(raw));
                if (snap)
                    recordSnapshot(snap);
            }
            catch {
                // No reading this time; still answer with the summary.
            }
            console.log(JSON.stringify(summary(Date.now(), { idle: false })));
            return;
        }
        case "statusline": {
            await statusline();
            return;
        }
        case "hook": {
            // Called by Claude Code's UserPromptSubmit hook. Must stay quiet and fast.
            await readStdin();
            if (rest[0] === "prompt")
                touchActivity();
            return;
        }
        case "log": {
            const n = Number(rest[rest.indexOf("-n") + 1]) || 30;
            try {
                console.log(readFileSync(paths.log(), "utf8").trimEnd().split("\n").slice(-n).join("\n"));
            }
            catch {
                console.log("No activity yet.");
            }
            return;
        }
        default:
            fail(`Unknown command "${cmd}".\n\n${HELP}`);
    }
}
main(process.argv.slice(2)).catch((e) => fail(e.message));
