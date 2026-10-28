#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig, setConfigValue, validate, type Size } from "./config.js";
import {
  initConfig,
  installDesktopMcp,
  installSchedule,
  pinClaudePath,
  uninstallDesktopMcp,
  uninstallSchedule,
  unwireClaudeSettings,
  wireClaudeSettings,
} from "./install.js";
import { cancelTask, readResult, retryTask, updateTask } from "./manage.js";
import { serve } from "./mcp.js";
import { setupWizard } from "./setup.js";
import { paths } from "./paths.js";
import { setMode, touchActivity } from "./presence.js";
import { probeUsage } from "./runner.js";
import { readStdin, statusline } from "./statusline.js";
import { readFileSync } from "node:fs";
import { compareTasks, estimate, findTask, loadRuns, loadTasks, newId, saveTasks, titleFrom, type Task } from "./tasks.js";
import { currentState, decide, tick } from "./tick.js";
import { summary } from "./summary.js";
import { parseStatusline, recordSnapshot } from "./usage.js";
import { WEEKDAYS } from "./time.js";

const HELP = `backburner: pace your Claude plan's weekly usage and spend the slack on queued tasks

Setup
  backburner setup                Answer a few questions and install everything
  backburner init                 Create config, hook into Claude Code's status line
  backburner schedule install     Run the queue in the background every 10 minutes
  backburner schedule uninstall   Stop background runs
  backburner desktop install      Let regular Claude Desktop chats queue tasks (MCP server)
  backburner desktop uninstall    Remove it from Claude Desktop
  backburner uninstall            Undo init's changes to Claude Code settings

Every day
  backburner status               Budget, reserves, presence and queue at a glance
  backburner add "<prompt>"       Queue a task
      --title <text>  --dir <path>  --code  --priority 1-5
      --deadline YYYY-MM-DD  --size small|medium|large
  backburner list [--all]         Show queued (or all) tasks with estimates
  backburner edit <id> [options]  Change a queued task (same options as add, plus --prompt)
  backburner remove <id>          Cancel a task
  backburner retry <id>           Queue a failed, cancelled or finished task again
  backburner result <id>          Print a finished task's report, or its branch and PR
  backburner away | active | auto Set your presence (auto watches for idle time)

Settings
  backburner config               Print the config file
  backburner config set <key> <value>
      e.g. reserves.sat 2, weeklyCap 95, releaseHour 23, guard warn, timezone America/Los_Angeles

Advanced
  backburner tick [--dry-run]     One scheduler pass (what the background job runs)
  backburner probe                Fetch fresh usage numbers now
  backburner log [-n 30]          Recent activity
`;

const fmtTime = (ms: number, tz: string) =>
  new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printStatus(json: boolean): void {
  const s = currentState();
  const tasks = loadTasks();
  const runs = loadRuns();
  const d = decide(s, tasks, runs);
  if (json) {
    console.log(JSON.stringify(summary(), null, 2));
    return;
  }
  const tz = s.config.timezone;
  if (!s.weekly || !s.budget) {
    console.log("No weekly usage reading yet. Open Claude Code once (the status line feeds Backburner), or run `backburner probe`.");
  } else {
    const b = s.budget;
    const age = Math.round((Date.now() - s.weekly.at) / 60_000);
    console.log(`Weekly usage    ${b.used}% of plan (read ${age} min ago), resets ${fmtTime(b.resetsAt, tz)}`);
    if (s.fiveHour) console.log(`5-hour window   ${s.fiveHour.pct.toFixed(0)}%, resets ${fmtTime(s.fiveHour.resetsAt, tz)}`);
    console.log(`Cap             ${b.cap}%`);
    console.log(
      `Today           reserve ${b.todayReserve}%, you've used ${b.personalToday}%, still held ${b.todayHeld}%${b.released ? " (released for tonight)" : ""}`,
    );
    console.log(`Later days      ${b.futureHeld}% held${b.sweeping ? " (final sweep: all reserves freed)" : ""}`);
    console.log(`Queue budget    ${b.available}%`);
  }
  console.log(`Presence        ${s.presence.effective} (${s.presence.mode}: ${s.presence.reason})`);
  const queued = tasks.filter((t) => t.status === "queued");
  const total = queued.reduce((sum, t) => sum + estimate(t.size, runs, s.config).pct, 0);
  console.log(`Queue           ${queued.length} task(s), about ${Math.round(total * 10) / 10}% estimated`);
  console.log(`Next step       ${d.run ? `run ${d.task!.id} "${d.task!.title}"` : `wait (${d.why})`}`);
}

function printList(all: boolean, json: boolean): void {
  const config = loadConfig();
  const runs = loadRuns();
  const tasks = loadTasks()
    .filter((t) => all || t.status === "queued" || t.status === "running")
    .sort(compareTasks);
  if (json) {
    const rows = tasks.map((t) => ({ ...t, estimate: estimate(t.size, runs, config) }));
    return console.log(JSON.stringify(rows));
  }
  if (tasks.length === 0) return console.log(all ? "No tasks yet." : "Queue is empty. Add one with: backburner add \"...\"");
  for (const t of tasks) {
    const e = estimate(t.size, runs, config);
    const due = t.deadline ? ` due ${t.deadline}` : "";
    console.log(`${t.id}  [${t.status}] P${t.priority} ${t.mode} ${t.size} ~${e.pct}% ~${e.minutes}min${due}  ${t.title}`);
    if (t.result) console.log(`        -> ${t.result}`);
    if (t.note) console.log(`        note: ${t.note}`);
  }
}

async function main(argv: string[]): Promise<void> {
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
        if (result.chained) console.log(`Your old status line still runs first: ${result.chained}`);
      } else console.log("Claude Code settings already wired.");
      console.log(`Claude CLI: ${config.run.claudePath}`);
      console.log("\nNext: open Claude Code once so the status line records your usage, then run `backburner schedule install`.");
      return;
    }

    case "uninstall": {
      const changed = unwireClaudeSettings(loadConfig());
      console.log(changed ? "Restored Claude Code settings." : "Nothing to undo in Claude Code settings.");
      console.log(uninstallSchedule());
      if (uninstallDesktopMcp()) console.log("Removed Backburner from Claude Desktop's MCP servers.");
      return;
    }

    case "desktop": {
      if (rest[0] === "install") {
        const { file, backup } = installDesktopMcp();
        console.log(`Added Backburner to ${file}${backup ? ` (backup: ${backup})` : ""}.`);
        console.log("Quit and reopen Claude Desktop, then ask Claude to queue something for Backburner.");
      } else if (rest[0] === "uninstall") {
        console.log(uninstallDesktopMcp() ? "Removed Backburner from Claude Desktop." : "Backburner wasn't in Claude Desktop's config.");
      } else fail("Usage: backburner desktop install|uninstall");
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
      } else if (rest[0] === "uninstall") console.log(uninstallSchedule());
      else fail("Usage: backburner schedule install|uninstall");
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
        },
      });
      const prompt = positionals.join(" ").trim();
      if (!prompt) fail('Usage: backburner add "<what Claude should do>" [--code] [--priority 1-5] [--deadline YYYY-MM-DD] [--size small|medium|large]');
      const priority = values.priority ? Number(values.priority) : 3;
      if (!Number.isInteger(priority) || priority < 1 || priority > 5) fail("--priority must be 1 to 5");
      const size = (values.size ?? "medium") as Size;
      if (!["small", "medium", "large"].includes(size)) fail("--size must be small, medium or large");
      if (values.deadline && Number.isNaN(Date.parse(values.deadline))) fail("--deadline must be a date like 2026-10-30");
      const task: Task = {
        id: newId(),
        title: values.title ?? titleFrom(prompt),
        prompt,
        dir: resolve(values.dir ?? process.cwd()),
        mode: values.code ? "code" : "research",
        priority,
        deadline: values.deadline,
        size,
        status: "queued",
        createdAt: Date.now(),
        attempts: 0,
      };
      saveTasks([...loadTasks(), task]);
      const e = estimate(size, loadRuns(), loadConfig());
      console.log(`Queued ${task.id}: ${task.title} (${task.mode}, ~${e.pct}%, ~${e.minutes} min)`);
      return;
    }

    case "list": {
      printList(rest.includes("--all"), rest.includes("--json"));
      return;
    }

    case "remove":
    case "cancel": {
      const r = cancelTask(rest[0] ?? "");
      if (!r.ok) fail(r.error);
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
        },
      });
      if (!positionals[0]) fail("Usage: backburner edit <id> [--prompt <text>] [--title <text>] [--priority 1-5] [--deadline YYYY-MM-DD|\"\"] [--size small|medium|large] [--code --dir <path> | --research]");
      const r = updateTask(positionals[0], {
        prompt: values.prompt,
        title: values.title,
        mode: values.code ? "code" : values.research ? "research" : undefined,
        dir: values.dir ? resolve(values.dir) : undefined,
        priority: values.priority === undefined ? undefined : Number(values.priority),
        deadline: values.deadline,
        size: values.size,
      });
      if (!r.ok) fail(r.error);
      console.log(`Updated ${r.task.id}: ${r.task.title} (P${r.task.priority} ${r.task.mode} ${r.task.size}${r.task.deadline ? ` due ${r.task.deadline}` : ""})`);
      return;
    }

    case "retry": {
      const r = retryTask(rest[0] ?? "");
      if (!r.ok) fail(r.error);
      console.log(`Queued again ${r.task.id}: ${r.task.title}`);
      return;
    }

    case "result": {
      const r = readResult(rest[0] ?? "", Number.POSITIVE_INFINITY);
      if (!r.ok) fail(r.error);
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
        if (!key || value.length === 0) fail("Usage: backburner config set <key> <value>");
        const next = setConfigValue(loadConfig(), key, value.join(" "));
        const errors = validate(next);
        if (errors.length) fail(errors.join("\n"));
        saveConfig(next);
        console.log(`Set ${key}.`);
      } else console.log(JSON.stringify(loadConfig(), null, 2));
      return;
    }

    case "tick": {
      for (const line of await tick({ dryRun: rest.includes("--dry-run") })) console.log(line);
      return;
    }

    case "probe": {
      const snap = await probeUsage(loadConfig());
      if (!snap) fail("Couldn't read usage. Is Claude Code installed and signed in with a Pro or Max plan?");
      console.log(`Weekly ${snap.weekly?.pct.toFixed(1) ?? "?"}%, 5-hour ${snap.fiveHour?.pct.toFixed(1) ?? "?"}%`);
      return;
    }

    case "ingest": {
      // Called by the Claude Code mod: usage in the status line's JSON shape on stdin, summary out.
      const raw = await readStdin();
      try {
        const snap = parseStatusline(JSON.parse(raw));
        if (snap) recordSnapshot(snap);
      } catch {
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
      if (rest[0] === "prompt") touchActivity();
      return;
    }

    case "log": {
      const n = Number(rest[rest.indexOf("-n") + 1]) || 30;
      try {
        console.log(readFileSync(paths.log(), "utf8").trimEnd().split("\n").slice(-n).join("\n"));
      } catch {
        console.log("No activity yet.");
      }
      return;
    }

    default:
      fail(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((e: Error) => fail(e.message));
