import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { handle } from "../src/mcp.js";
import { loadPresence } from "../src/presence.js";
import { loadTasks, saveTasks } from "../src/tasks.js";

beforeEach(() => {
  process.env.BACKBURNER_HOME = mkdtempSync(join(tmpdir(), "bb-mcp-"));
});

const call = (name: string, args: Record<string, unknown>) =>
  handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as {
    result: { content: { text: string }[]; isError?: boolean };
  };

describe("mcp server", () => {
  it("answers initialize and lists its tools", () => {
    const init = handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) as { result: { capabilities: object } };
    expect(init.result.capabilities).toHaveProperty("tools");
    const list = handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "add_task",
      "list_tasks",
      "update_task",
      "retry_task",
      "cancel_task",
      "get_result",
      "get_budget",
      "set_presence",
      "get_settings",
      "change_setting",
    ]);
  });

  it("sends instructions so Claude can use it unprompted", () => {
    const init = handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) as { result: { instructions: string } };
    expect(init.result.instructions).toMatch(/add_task/);
    expect(init.result.instructions).toMatch(/stands alone/);
  });

  it("edits, retries and reads results", () => {
    call("add_task", { prompt: "Find three cheap flights to Taipei", size: "small" });
    const [task] = loadTasks();
    const edited = call("update_task", { id: task!.id, priority: 5, deadline: "2026-12-01", size: "medium" });
    expect(edited.result.isError).toBeUndefined();
    expect(loadTasks()[0]).toMatchObject({ priority: 5, deadline: "2026-12-01", size: "medium" });
    expect(call("update_task", { id: task!.id, deadline: "" }).result.isError).toBeUndefined();
    expect(loadTasks()[0]!.deadline).toBeUndefined();
    expect(call("update_task", { id: task!.id, priority: 9 }).result.isError).toBe(true);
    expect(call("update_task", { id: task!.id, mode: "code" }).result.isError).toBe(true);

    expect(call("get_result", { id: task!.id }).result.content[0]!.text).toMatch(/hasn't finished/);
    expect(call("retry_task", { id: task!.id }).result.isError).toBe(true);

    const dir = process.env.BACKBURNER_HOME!;
    const report = join(dir, "report.md");
    writeFileSync(report, "# Flights\n\nEVA, $640");
    const tasks = loadTasks();
    Object.assign(tasks[0]!, { status: "failed", attempts: 2, result: report, note: "timeout" });
    saveTasks(tasks);
    expect(call("update_task", { id: task!.id, title: "x" }).result.isError).toBe(true);
    expect(call("get_result", { id: task!.id }).result.content[0]!.text).toContain("EVA, $640");
    expect(call("retry_task", { id: task!.id }).result.content[0]!.text).toMatch(/^Queued again/);
    expect(loadTasks()[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(loadTasks()[0]!.note).toBeUndefined();
  });

  it("sets presence", () => {
    expect(call("set_presence", { mode: "away" }).result.content[0]!.text).toBe("Presence set to away.");
    expect(loadPresence().mode).toBe("away");
    expect(call("set_presence", { mode: "gone" }).result.isError).toBe(true);
  });

  it("changes allowed settings and refuses the rest", () => {
    expect(call("change_setting", { key: "reserves.sat", value: "2" }).result.isError).toBeUndefined();
    expect(loadConfig().reserves.sat).toBe(2);
    expect(call("change_setting", { key: "weeklyCap", value: "150" }).result.isError).toBe(true);
    expect(call("change_setting", { key: "weeklyCap", value: "abc" }).result.isError).toBe(true);
    expect(call("change_setting", { key: "run.codeTools", value: "Bash" }).result.isError).toBe(true);
    expect(call("change_setting", { key: "run.claudePath", value: "evil" }).result.isError).toBe(true);
    expect(loadConfig().weeklyCap).toBe(95);
    const shown = call("get_settings", {}).result.content[0]!.text;
    expect(shown).toContain('"sat": 2');
    expect(shown).not.toContain("codeTools");
  });

  it("ignores notifications and rejects unknown methods", () => {
    expect(handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(handle({ jsonrpc: "2.0", id: 2, method: "nope" })).toMatchObject({ error: { code: -32601 } });
  });

  it("adds, lists and cancels tasks", () => {
    const added = call("add_task", { prompt: "Compare three note-taking apps for students", priority: 4, size: "small" });
    expect(added.result.content[0]!.text).toMatch(/^Queued \w{6}: "Compare three note-taking apps for students"/);
    const [task] = loadTasks();
    expect(task).toMatchObject({ priority: 4, size: "small", mode: "research", status: "queued" });

    expect(call("list_tasks", {}).result.content[0]!.text).toContain(task!.id);
    expect(call("cancel_task", { id: task!.id.slice(0, 4) }).result.content[0]!.text).toMatch(/^Cancelled/);
    expect(call("list_tasks", {}).result.content[0]!.text).toBe("The queue is empty.");
  });

  it("requires an absolute repo path for coding tasks", () => {
    const r = call("add_task", { prompt: "Fix the bug", mode: "code", dir: "relative/path" });
    expect(r.result.isError).toBe(true);
    expect(loadTasks()).toHaveLength(0);
  });

  it("explains a missing usage reading", () => {
    expect(call("get_budget", {}).result.content[0]!.text).toMatch(/No weekly usage reading yet/);
  });
});
