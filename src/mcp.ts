import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, type Size } from "./config.js";
import { summary } from "./summary.js";
import { compareTasks, estimate, findTask, loadRuns, loadTasks, newId, saveTasks, titleFrom, type Task } from "./tasks.js";

// A minimal MCP server over stdio (newline-delimited JSON-RPC), so regular Claude
// chat in the Desktop app can add and review tasks. No SDK dependency.

const PROTOCOL = "2025-06-18";

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
        size: {
          type: "string",
          enum: ["small", "medium", "large"],
          description: "small: a quick lookup or one-file tweak (~10 min). medium: a researched summary or a focused change (~30 min). large: deep research or a multi-file feature (~90 min).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_tasks",
    description: "List Backburner's queued tasks with their usage and time estimates.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include finished and cancelled tasks." } } },
  },
  {
    name: "cancel_task",
    description: "Cancel a queued Backburner task by its id (or a unique prefix of it).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_budget",
    description: "Show the user's weekly usage, reserves, and how much the Backburner queue can spend right now.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Args = Record<string, unknown>;

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

export function callTool(name: string, args: Args): ReturnType<typeof text> {
  const config = loadConfig();
  switch (name) {
    case "add_task": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return text("prompt is required", true);
      const mode = args.mode === "code" ? "code" : "research";
      const dirArg = typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : undefined;
      if (mode === "code" && (!dirArg || !isAbsolute(dirArg))) return text("Coding tasks need dir: the absolute path of the git repository.", true);
      const priority = Number.isInteger(args.priority) ? Math.min(5, Math.max(1, args.priority as number)) : 3;
      const size = (["small", "medium", "large"].includes(String(args.size)) ? args.size : "medium") as Size;
      const deadline = typeof args.deadline === "string" && !Number.isNaN(Date.parse(args.deadline)) ? args.deadline : undefined;
      const task: Task = {
        id: newId(),
        title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : titleFrom(prompt),
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
      return text(`Queued ${task.id}: "${task.title}" (${mode}, priority ${priority}, about ${e.pct}% of the week and ${e.minutes} min).`);
    }
    case "list_tasks": {
      const runs = loadRuns();
      const rows = loadTasks()
        .filter((t) => args.all || t.status === "queued" || t.status === "running")
        .sort(compareTasks)
        .map((t) => {
          const e = estimate(t.size, runs, config);
          return `${t.id} [${t.status}] P${t.priority} ${t.mode} ~${e.pct}% ~${e.minutes}min${t.deadline ? ` due ${t.deadline}` : ""}: ${t.title}${t.result ? ` -> ${t.result}` : ""}`;
        });
      return text(rows.length ? rows.join("\n") : "The queue is empty.");
    }
    case "cancel_task": {
      const tasks = loadTasks();
      const t = findTask(tasks, String(args.id ?? ""));
      if (!t) return text(`No single task matches "${String(args.id ?? "")}".`, true);
      t.status = "cancelled";
      saveTasks(tasks);
      return text(`Cancelled ${t.id}: ${t.title}`);
    }
    case "get_budget": {
      const s = summary(Date.now(), { idle: false });
      if (!s.budget) return text("No weekly usage reading yet. It appears after the next Claude Code session or background check.");
      const b = s.budget;
      return text(
        [
          `Weekly usage: ${b.used}% (cap ${b.cap}%)`,
          `Today: ${b.personalToday}% used of a ${b.todayReserve}% reserve, ${b.todayHeld}% still held`,
          `Later days: ${b.futureHeld}% held${b.sweeping ? " (final sweep: all freed)" : ""}`,
          `Queue can spend now: ${b.available}%`,
          `Queued: ${s.queued} task(s), about ${s.queuedPct}%`,
          `Presence: ${s.presence.effective} (${s.presence.mode})`,
        ].join("\n"),
      );
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
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "backburner", version: "0.1.0" } });
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
    rl.on("line", (line) => {
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
