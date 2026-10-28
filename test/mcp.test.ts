import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/mcp.js";
import { loadTasks } from "../src/tasks.js";

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
    expect(list.result.tools.map((t) => t.name)).toEqual(["add_task", "list_tasks", "cancel_task", "get_budget"]);
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
