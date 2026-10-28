import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addCodexServer, AGENTS, codexSkillText, disconnectAgent, findAgent, removeCodexServer, tomlString } from "../src/agents.js";
import { DEFAULT_CONFIG, saveConfig, setConfigValue, validate, type Config } from "../src/config.js";
import { callTool } from "../src/mcp.js";
import { runTask } from "../src/runner.js";
import { summary } from "../src/summary.js";
import { estimate, pickNext, saveTasks, type Run, type Task } from "../src/tasks.js";
import { currentState, decide } from "../src/tick.js";
import { loadSnapshots, parseCodexRecord, readCodexUsage, recordSnapshot } from "../src/usage.js";

const HOUR = 3_600_000;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bb-agents-"));
  process.env.BACKBURNER_HOME = join(root, "bb");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.HOME = join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  mkdirSync(process.env.HOME, { recursive: true });
});

const task = (over: Partial<Task> = {}): Task => ({
  id: over.id ?? "t1",
  title: "Task",
  prompt: "Do it",
  dir: root,
  mode: "research",
  priority: 3,
  size: "small",
  status: "queued",
  createdAt: 1,
  attempts: 0,
  ...over,
});

/** A Codex session log line the way Codex writes it. */
function tokenCount(now: number, weekly: number, fiveHour: number) {
  return {
    timestamp: new Date(now).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        primary: { used_percent: fiveHour, window_minutes: 299, resets_at: Math.floor((now + 2 * HOUR) / 1000) },
        secondary: { used_percent: weekly, window_minutes: 10079, resets_in_seconds: 3 * 24 * 3600 },
      },
    },
  };
}

function writeRollout(now: number, lines: unknown[]): string {
  const d = new Date(now);
  const dir = join(process.env.CODEX_HOME!, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${now}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("Codex usage", () => {
  it("reads both windows from a token_count record", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const snap = parseCodexRecord(tokenCount(now, 40, 12))!;
    expect(snap.provider).toBe("codex");
    expect(snap.weekly?.pct).toBe(40);
    expect(snap.weekly?.resetsAt).toBe(now + 3 * 24 * HOUR);
    expect(snap.fiveHour).toEqual({ pct: 12, resetsAt: Math.floor((now + 2 * HOUR) / 1000) * 1000 });
  });

  it("ignores records without rate limits", () => {
    expect(parseCodexRecord({ type: "event_msg", payload: { type: "token_count", rate_limits: null } })).toBeUndefined();
    expect(parseCodexRecord({ type: "response_item", payload: {} })).toBeUndefined();
  });

  it("finds the newest reading in today's session logs", () => {
    const now = Date.now();
    writeRollout(now, [{ type: "session_meta", payload: {} }, tokenCount(now - 60_000, 30, 5), { type: "event_msg", payload: { type: "agent_message" } }, tokenCount(now, 31, 6)]);
    expect(readCodexUsage(now)?.weekly?.pct).toBe(31);
  });
});

describe("several plans", () => {
  const both: Config = { ...DEFAULT_CONFIG, timezone: "UTC", engines: ["claude", "codex"] };

  it("keeps estimates and readings apart per plan", () => {
    const runs: Run[] = [1, 2, 3].map((i) => ({ id: `r${i}`, taskId: "x", size: "small", provider: "codex", startedAt: 0, endedAt: 600_000, weeklyBefore: 10, weeklyAfter: 14, outcome: "done" }));
    expect(estimate("small", runs, both, "codex").pct).toBe(4);
    expect(estimate("small", runs, both, "claude").basis).toBe("default");

    const now = Date.now();
    recordSnapshot({ at: now, source: "statusline", weekly: { pct: 50, resetsAt: now + 3 * 24 * HOUR } });
    recordSnapshot({ at: now, source: "codex", provider: "codex", weekly: { pct: 20, resetsAt: now + 3 * 24 * HOUR } });
    expect(loadSnapshots("claude").map((s) => s.weekly?.pct)).toEqual([50]);
    expect(loadSnapshots("codex").map((s) => s.weekly?.pct)).toEqual([20]);
  });

  it("runs a task pinned to one plan only on that plan", () => {
    const tasks = [task({ id: "a", engine: "codex" }), task({ id: "b", createdAt: 2 })];
    expect(pickNext(tasks, 50, [], both, "claude")?.id).toBe("b");
    expect(pickNext(tasks, 50, [], both, "codex")?.id).toBe("a");
    expect(pickNext(tasks, 50, [], { ...both, engines: ["claude"] }, "codex")).toBeUndefined();
  });

  it("spends Codex when Claude is out of room", () => {
    saveConfig(both);
    const now = Date.now();
    const resetsAt = now + 2 * HOUR; // inside the final sweep, so no reserves hold anything back
    recordSnapshot({ at: now, source: "statusline", weekly: { pct: 94.5, resetsAt } });
    writeRollout(now, [{ ...tokenCount(now, 20, 1), payload: { ...tokenCount(now, 20, 1).payload, rate_limits: { secondary: { used_percent: 20, window_minutes: 10079, resets_at: Math.floor(resetsAt / 1000) } } } }]);
    saveTasks([task()]);

    const claude = currentState(now, { idle: false, provider: "claude" });
    const codex = currentState(now, { idle: false, provider: "codex" });
    expect(decide(claude, [task()], []).run).toBe(false);
    expect(codex.budget?.available).toBe(75);
    expect(decide(codex, [task()], []).task?.id).toBe("t1");

    const s = summary(now, { idle: false });
    expect(s.engines.map((e) => [e.provider, e.next.run])).toEqual([
      ["claude", false],
      ["codex", true],
    ]);
    expect(s.budget?.used).toBe(94.5); // the top level stays Claude's, for the Claude Code band
  });

  it("validates and sets the engine list", () => {
    expect(validate(setConfigValue(DEFAULT_CONFIG, "engines", "claude,codex"))).toEqual([]);
    expect(validate(setConfigValue(DEFAULT_CONFIG, "engines", "gpt"))).toContainEqual(expect.stringMatching(/engines/));
    expect(setConfigValue(DEFAULT_CONFIG, "codex.model", "gpt-5-codex").codex.model).toBe("gpt-5-codex");
  });

  it("chat can pin a task to Codex only when Codex is set up", () => {
    saveConfig(DEFAULT_CONFIG);
    expect(callTool("add_task", { prompt: "x", engine: "codex" }).isError).toBe(true);
    saveConfig({ ...DEFAULT_CONFIG, engines: ["claude", "codex"] });
    expect(callTool("add_task", { prompt: "x", engine: "codex" }).content[0]!.text).toMatch(/on Codex/);
    expect(callTool("list_tasks", {}).content[0]!.text).toMatch(/on Codex/);
  });
});

/** A stand-in `codex` that prints `codex exec --json` events and writes a session log. */
function fakeCodex(events: unknown[], finalText?: string): string {
  const script = join(root, "fake-codex.mjs");
  const now = Date.now();
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(args));
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(join(root, "stdin.txt"))}, stdin);
  const o = args[args.indexOf("-o") + 1];
  ${finalText !== undefined ? `writeFileSync(o, ${JSON.stringify(finalText)});` : ""}
  const d = new Date(${now});
  const dir = join(process.env.CODEX_HOME, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-x.jsonl"), ${JSON.stringify(JSON.stringify(tokenCount(now, 33, 4)))} + "\\n");
  for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

describe.skipIf(process.platform === "win32")("Codex runner", () => {
  const config = (path: string): Config => ({ ...DEFAULT_CONFIG, engines: ["codex"], codex: { path, search: true } });

  it("runs a research task read-only, saves the report and the usage reading", async () => {
    const codex = fakeCodex(
      [{ type: "thread.started", thread_id: "x" }, { type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "draft" } }, { type: "turn.completed", usage: {} }],
      "The final report",
    );
    const r = await runTask(task({ prompt: "Compare note apps" }), "run1", config(codex), "codex");
    expect(r.outcome).toBe("done");
    expect(readFileSync(r.result!, "utf8")).toMatch(/The final report/);
    const args = JSON.parse(readFileSync(join(root, "args.json"), "utf8")) as string[];
    expect(args.slice(0, 3)).toEqual(["--search", "exec", "--json"]);
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args.at(-1)).toBe("-");
    expect(readFileSync(join(root, "stdin.txt"), "utf8")).toMatch(/Compare note apps$/);
    expect(r.lastSnapshot?.weekly?.pct).toBe(33);
    expect(loadSnapshots("codex").at(-1)?.weekly?.pct).toBe(33);
  });

  it("ignores errors Codex recovers from", async () => {
    const codex = fakeCodex([{ type: "turn.started" }, { type: "error", message: "Reconnecting... 1/5 (stream disconnected)" }, { type: "turn.completed" }], "ok");
    expect((await runTask(task(), "run4", config(codex), "codex")).outcome).toBe("done");
  });

  it("fails when Codex gives up reconnecting", async () => {
    const codex = fakeCodex([{ type: "turn.started" }, { type: "error", message: "Reconnecting... 5/5 (401 Unauthorized)" }]);
    const r = await runTask(task(), "run5", config(codex), "codex");
    expect(r.outcome).toBe("failed");
  });

  it("treats a usage limit as a limit, not a failure", async () => {
    const codex = fakeCodex([{ type: "turn.started" }, { type: "error", message: "You've hit your usage limit. Try again later." }, { type: "turn.failed", error: { message: "You've hit your usage limit." } }]);
    const r = await runTask(task(), "run2", config(codex), "codex");
    expect(r.outcome).toBe("limit");
  });

  it("fails a run that stops before the turn finishes", async () => {
    const codex = fakeCodex([{ type: "turn.started" }]);
    const r = await runTask(task(), "run3", config(codex), "codex");
    expect(r.outcome).toBe("failed");
  });
});

describe("connecting agents", () => {
  it("adds Backburner to a Codex config.toml without touching the rest", () => {
    const before = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.backburner]\ncommand = "old"\n\n[mcp_servers.backburner.env]\nA = "1"\n\n[profiles.fast]\nmodel = "o4-mini"\n`;
    const after = addCodexServer(before, { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\a\\cli.js", "mcp"] });
    expect(after).toContain(`[mcp_servers.other]\ncommand = "x"`);
    expect(after).toContain(`[profiles.fast]\nmodel = "o4-mini"`);
    expect(after).not.toContain("old");
    expect(after).not.toContain("backburner.env");
    expect(after.trimEnd().endsWith(`[mcp_servers.backburner]\ncommand = 'C:\\Program Files\\nodejs\\node.exe'\nargs = ['C:\\Users\\a\\cli.js', 'mcp']`)).toBe(true);
    expect(removeCodexServer(after)).not.toContain("backburner");
    expect(tomlString("it's")).toBe(`"it's"`);
  });

  it("connects and disconnects Codex: tools, skill and plan", () => {
    const codex = findAgent("codex")!;
    const { config, message } = codex.connect(DEFAULT_CONFIG);
    expect(message).toMatch(/Codex/);
    expect(config.engines).toEqual(["claude", "codex"]);
    expect(codex.connected(config)).toBe(true);
    expect(readFileSync(join(process.env.CODEX_HOME!, "config.toml"), "utf8")).toMatch(/\[mcp_servers\.backburner\]/);
    const skill = join(process.env.CODEX_HOME!, "skills", "backburner", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toBe(codexSkillText());
    expect(codexSkillText()).toMatch(/^---\nname: backburner\ndescription: /);

    const off = disconnectAgent(codex, config);
    expect(off.changed).toBe(true);
    expect(off.config.engines).toEqual(["claude"]);
    expect(existsSync(skill)).toBe(false);
    expect(codex.connected(off.config)).toBe(false);
  });

  it.each(["gemini", "cursor", "windsurf"])("adds and removes the MCP server for %s", (id) => {
    const a = findAgent(id)!;
    expect(a.connected(DEFAULT_CONFIG)).toBe(false);
    a.connect(DEFAULT_CONFIG);
    expect(a.connected(DEFAULT_CONFIG)).toBe(true);
    expect(a.disconnect(DEFAULT_CONFIG)).toBe(true);
    expect(a.connected(DEFAULT_CONFIG)).toBe(false);
  });

  it("keeps other MCP servers in a JSON config", () => {
    const file = join(process.env.HOME!, ".cursor", "mcp.json");
    mkdirSync(join(process.env.HOME!, ".cursor"));
    writeFileSync(file, JSON.stringify({ mcpServers: { github: { command: "gh" } } }));
    findAgent("cursor")!.connect(DEFAULT_CONFIG);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { args?: string[] }> };
    expect(Object.keys(saved.mcpServers)).toEqual(["github", "backburner"]);
    expect(saved.mcpServers.backburner!.args?.at(-1)).toBe("mcp");
  });

  it("knows every agent by id or name", () => {
    expect(AGENTS.map((a) => a.id)).toEqual(["claude-code", "claude-desktop", "codex", "gemini", "cursor", "windsurf"]);
    expect(findAgent("Gemini CLI")?.id).toBe("gemini");
    expect(findAgent("claude")?.id).toBe("claude-code");
  });
});
