import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, saveConfig, setConfigValue, validate, type Config, type Size } from "./config.js";
import { cancelTask, readResult, retryTask, updateTask } from "./manage.js";
import { setMode, type PresenceMode } from "./presence.js";
import { summary } from "./summary.js";
import { compareTasks, estimate, loadRuns, loadTasks, newId, saveTasks, titleFrom, type Task } from "./tasks.js";

// A minimal MCP server over stdio (newline-delimited JSON-RPC), so regular Claude
// chat in the Desktop app can run Backburner for the user. No SDK dependency.

const PROTOCOL = "2025-06-18";
const VERSION = "0.2.0";

/** Sent to Claude when the chat connects, so it can manage Backburner without the user explaining it. */
export const INSTRUCTIONS = `Backburner is a program on the user's own computer that paces their Claude plan's weekly usage. It holds a small daily reserve for the user's own chats, never lets queued work push weekly usage past a cap (default 95%), and runs queued tasks unattended with Claude Code (\`claude -p\`) when there's usage to spare: overnight, while the user is away, or in the last hours before the weekly reset.

Use these tools to manage it for the user, so they don't have to. Act on clear requests directly; don't ask the user to run commands.

Queueing (add_task):
- Use it when the user says "queue", "put on the backburner", "do this later", "when I have usage left", or hands over research or coding work that can wait.
- The run can't see this conversation. Write a prompt that stands alone: the goal, every relevant detail from the chat, constraints, and what the output should look like.
- mode "research" (default) can search the web and read files, and ends in a markdown report. mode "code" edits a git repository on the user's computer on its own branch and can open a draft PR; it needs dir, the repo's absolute path. Ask for the path if you don't know it.
- size: small (~1% of the week, ~10 min) for a quick lookup, medium (~3%, ~30 min) for a researched summary or focused change, large (~8%, ~90 min) for deep research or a multi-file feature. Pick one yourself.
- priority 1 (low) to 5 (high), default 3. Set a deadline (YYYY-MM-DD) only if the user gives one. Tasks run by earliest deadline, then priority, then age.
- After adding, tell the user the title, size, and the estimate the tool returned.

Managing: list_tasks shows the queue (all: true includes finished tasks). update_task changes a queued task. retry_task puts a failed, cancelled or finished task back in the queue. cancel_task removes one. Ids can be shortened to a unique prefix. get_result returns a finished task's report or its branch and PR.

Budget and presence: get_budget shows weekly usage, what the queue may spend now, and why the next task is or isn't running. set_presence "away" lets the queue run freely (use it when the user says they're leaving, going to bed, or want the queue to start); "active" holds it back while they work; "auto" (default) decides from idle time.

Settings: get_settings shows them; change_setting changes one. Common keys: reserves.mon ... reserves.sun (weekly % held each day for the user, default 5 weekdays and 3 weekends), weeklyCap, releaseHour (local hour when today's unused reserve goes to the queue), timezone, run.model, run.timeoutMinutes, guard (off, warn or block). Tool lists and the Claude CLI path can only be changed by the user in a terminal.

Nothing runs the instant a task is queued: a background job checks every 10 minutes. If get_budget says there's no usage reading yet, the user needs to open Claude Code once or run \`backburner probe\`.`;

/** Settings chat may change. Tool permissions and executable paths stay terminal-only. */
const CHAT_SETTINGS = [
  "timezone",
  "reserves.mon",
  "reserves.tue",
  "reserves.wed",
  "reserves.thu",
  "reserves.fri",
  "reserves.sat",
  "reserves.sun",
  "weeklyCap",
  "releaseHour",
  "sweepHours",
  "presence.idleMinutes",
  "fiveHour.maxWhileActive",
  "fiveHour.maxWhileAway",
  "estimates.small.pct",
  "estimates.small.minutes",
  "estimates.medium.pct",
  "estimates.medium.minutes",
  "estimates.large.pct",
  "estimates.large.minutes",
  "run.model",
  "run.timeoutMinutes",
  "run.openDraftPr",
  "guard",
  "statusline.showLine",
];

const SIZE_HELP =
  "small: a quick lookup or one-file tweak (~10 min). medium: a researched summary or a focused change (~30 min). large: deep research or a multi-file feature (~90 min).";

const TOOLS = [
  {
    name: "add_task",
    description:
      "Queue a task for Backburner, which runs it later with Claude Code when the user has spare weekly usage. Write the prompt so it stands alone: the run has no access to this conversation. Use mode 'code' only for changes to a git repository on the user's computer, and give its absolute path as dir.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full instructions for the unattended run." },
        title: { type: "string", description: "Short name for the queue list." },
        mode: { type: "string", enum: ["research", "code"], description: "research: web search and reading, ends in a report. code: edits a repo on its own branch." },
        dir: { type: "string", description: "Absolute folder to run in. Required for code tasks." },
        priority: { type: "integer", minimum: 1, maximum: 5, description: "1 low to 5 high. Default 3." },
        deadline: { type: "string", description: "YYYY-MM-DD the user wants it done by, if any." },
        size: { type: "string", enum: ["small", "medium", "large"], description: SIZE_HELP },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_tasks",
    description: "List Backburner's queued tasks with their usage and time estimates.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include finished, failed and cancelled tasks." } } },
  },
  {
    name: "update_task",
    description: "Change a queued Backburner task. Pass only the fields to change. Pass deadline as an empty string to clear it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id or a unique prefix of it." },
        prompt: { type: "string" },
        title: { type: "string" },
        mode: { type: "string", enum: ["research", "code"] },
        dir: { type: "string", description: "Absolute folder. Required if mode becomes code." },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        deadline: { type: "string", description: "YYYY-MM-DD, or empty to clear." },
        size: { type: "string", enum: ["small", "medium", "large"], description: SIZE_HELP },
      },
      required: ["id"],
    },
  },
  {
    name: "retry_task",
    description: "Put a failed, cancelled or finished Backburner task back in the queue with its attempts reset.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "cancel_task",
    description: "Cancel a queued Backburner task by its id (or a unique prefix of it).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_result",
    description: "Get what a Backburner task produced: the report text for research tasks, or the branch and pull request for coding tasks.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_budget",
    description: "Show the user's weekly usage, reserves, how much the Backburner queue can spend right now, and why the next task is or isn't running.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_presence",
    description:
      "Tell Backburner whether the user is around. away: the queue may run freely within the budget. active: it holds back so it doesn't crowd the user out. auto: decide from keyboard, mouse and Claude Code activity.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["away", "active", "auto"] } }, required: ["mode"] },
  },
  {
    name: "get_settings",
    description: "Show Backburner's settings: time zone, daily reserves, weekly cap, release hour, run options and pace guard.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "change_setting",
    description: `Change one Backburner setting. Allowed keys: ${CHAT_SETTINGS.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: CHAT_SETTINGS },
        value: { type: "string", description: "New value, e.g. 3, 95, true, sonnet, warn or America/Los_Angeles." },
      },
      required: ["key", "value"],
    },
  },
];

type Args = Record<string, unknown>;

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
const SIZES = ["small", "medium", "large"];

function describe(t: Task, config: Config, runs = loadRuns()): string {
  const e = estimate(t.size, runs, config);
  return `${t.id} [${t.status}] P${t.priority} ${t.mode} ${t.size} ~${e.pct}% ~${e.minutes}min${t.deadline ? ` due ${t.deadline}` : ""}: ${t.title}${t.result ? ` -> ${t.result}` : ""}${t.note ? ` (note: ${t.note})` : ""}`;
}

export function callTool(name: string, args: Args): ReturnType<typeof text> {
  const config = loadConfig();
  switch (name) {
    case "add_task": {
      const prompt = str(args.prompt);
      if (!prompt) return text("prompt is required", true);
      const mode = args.mode === "code" ? "code" : "research";
      const dirArg = str(args.dir) || undefined;
      if (mode === "code" && (!dirArg || !isAbsolute(dirArg))) return text("Coding tasks need dir: the absolute path of the git repository.", true);
      const priority = Number.isInteger(args.priority) ? Math.min(5, Math.max(1, args.priority as number)) : 3;
      const size = (SIZES.includes(String(args.size)) ? args.size : "medium") as Size;
      const deadline = typeof args.deadline === "string" && !Number.isNaN(Date.parse(args.deadline)) ? args.deadline : undefined;
      const task: Task = {
        id: newId(),
        title: str(args.title) || titleFrom(prompt),
        prompt,
        dir: resolve(dirArg ?? homedir()),
        mode,
        priority,
        deadline,
        size,
        status: "queued",
        createdAt: Date.now(),
        attempts: 0,
      };
      saveTasks([...loadTasks(), task]);
      const e = estimate(size, loadRuns(), config);
      return text(`Queued ${task.id}: "${task.title}" (${mode}, ${size}, priority ${priority}, about ${e.pct}% of the week and ${e.minutes} min).`);
    }
    case "list_tasks": {
      const runs = loadRuns();
      const rows = loadTasks()
        .filter((t) => args.all || t.status === "queued" || t.status === "running")
        .sort(compareTasks)
        .map((t) => describe(t, config, runs));
      return text(rows.length ? rows.join("\n") : args.all ? "No tasks yet." : "The queue is empty.");
    }
    case "update_task": {
      const r = updateTask(String(args.id ?? ""), {
        prompt: str(args.prompt),
        title: str(args.title),
        mode: args.mode === "research" || args.mode === "code" ? args.mode : undefined,
        dir: str(args.dir),
        priority: args.priority === undefined ? undefined : Number(args.priority),
        deadline: typeof args.deadline === "string" ? args.deadline : undefined,
        size: args.size === undefined ? undefined : String(args.size),
      });
      return r.ok ? text(`Updated ${describe(r.task, config)}`) : text(r.error, true);
    }
    case "retry_task": {
      const r = retryTask(String(args.id ?? ""));
      return r.ok ? text(`Queued again: ${describe(r.task, config)}`) : text(r.error, true);
    }
    case "cancel_task": {
      const r = cancelTask(String(args.id ?? ""));
      return r.ok ? text(`Cancelled ${r.task.id}: ${r.task.title}`) : text(r.error, true);
    }
    case "get_result": {
      const r = readResult(String(args.id ?? ""));
      return r.ok ? text(r.text) : text(r.error, true);
    }
    case "get_budget": {
      const s = summary(Date.now(), { idle: false });
      const next = s.next.run ? `Next: run ${s.next.taskId} "${s.next.title}" at the next check` : `Next: waiting (${s.next.why})`;
      if (!s.budget) return text(`No weekly usage reading yet. It appears after the user opens Claude Code or runs \`backburner probe\`.\n${next}`);
      const b = s.budget;
      const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: s.timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
      return text(
        [
          `Weekly usage: ${b.used}% (cap ${b.cap}%)${s.weekly ? `, resets ${when(s.weekly.resetsAt)}` : ""}`,
          ...(s.fiveHour ? [`5-hour window: ${Math.round(s.fiveHour.pct)}%, resets ${when(s.fiveHour.resetsAt)}`] : []),
          `Today: ${b.personalToday}% used of a ${b.todayReserve}% reserve, ${b.todayHeld}% still held${b.released ? " (released for tonight)" : ""}`,
          `Later days: ${b.futureHeld}% held${b.sweeping ? " (final sweep: all freed)" : ""}`,
          `Queue can spend now: ${b.available}%`,
          `Queued: ${s.queued} task(s), about ${s.queuedPct}%`,
          `Presence: ${s.presence.effective} (${s.presence.mode}: ${s.presence.reason})`,
          next,
        ].join("\n"),
      );
    }
    case "set_presence": {
      const mode = String(args.mode ?? "");
      if (!["away", "active", "auto"].includes(mode)) return text('mode must be "away", "active" or "auto".', true);
      setMode(mode as PresenceMode);
      return text(`Presence set to ${mode}.`);
    }
    case "get_settings": {
      const { integration: _i, statusline, run, ...rest } = config;
      const shown = { ...rest, run: { model: run.model ?? "(Claude Code's default)", timeoutMinutes: run.timeoutMinutes, openDraftPr: run.openDraftPr }, statusline: { showLine: statusline.showLine } };
      return text(JSON.stringify(shown, null, 2));
    }
    case "change_setting": {
      const key = String(args.key ?? "");
      const value = String(args.value ?? "").trim();
      if (!CHAT_SETTINGS.includes(key)) return text(`${key} can't be changed from chat. Allowed: ${CHAT_SETTINGS.join(", ")}.`, true);
      if (!value) return text("value is required.", true);
      let next: Config;
      try {
        next = setConfigValue(config, key, value);
      } catch (e) {
        return text((e as Error).message, true);
      }
      const errors = validate(next);
      const leaf = key.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], next);
      if (typeof leaf === "number" && !Number.isFinite(leaf)) errors.push(`${key} must be a number`);
      if (errors.length) return text(errors.join("\n"), true);
      saveConfig(next);
      return text(`Set ${key} to ${value}.`);
    }
    default:
      return text(`Unknown tool ${name}`, true);
  }
}

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Args };

export function handle(req: Request): object | undefined {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "backburner", version: VERSION }, instructions: INSTRUCTIONS });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const p = req.params ?? {};
      try {
        return reply(callTool(String(p.name), (p.arguments as Args) ?? {}));
      } catch (e) {
        return reply(text(`Backburner error: ${(e as Error).message}`, true));
      }
    }
    default:
      if (req.id === undefined) return undefined; // a notification
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

export function serve(): Promise<void> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (raw) => {
      const line = raw.replace(/^﻿/, ""); // Windows PowerShell pipes start with a byte order mark
      if (!line.trim()) return;
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        return;
      }
      const res = handle(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    });
    rl.on("close", () => done());
  });
}
