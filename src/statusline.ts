import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { log } from "./store.js";
import { loadTasks } from "./tasks.js";
import { currentState } from "./tick.js";
import { parseStatusline, recordSnapshot } from "./usage.js";

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** One short line for the bottom of Claude Code. */
export function ownLine(now = Date.now()): string {
  const s = currentState(now, { idle: false });
  const queued = loadTasks().filter((t) => t.status === "queued").length;
  const who = s.presence.mode === "auto" ? `auto (${s.presence.effective})` : s.presence.effective;
  if (!s.budget) return `backburner: waiting for a usage reading · ${queued} queued · ${who}`;
  const b = s.budget;
  const mode = b.sweeping ? " · final sweep" : "";
  return `backburner: queue can spend ${b.available}% · ${queued} queued · ${who}${mode}`;
}

/**
 * Status line entry point. Saves the usage numbers Claude Code passes in, runs your
 * previous status line command (if any) with the same input, then adds one line.
 */
export async function statusline(): Promise<void> {
  const raw = await readStdin();
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    input = undefined;
  }
  const snap = parseStatusline(input);
  if (snap) {
    try {
      recordSnapshot(snap);
    } catch (e) {
      log(`statusline: could not save reading: ${(e as Error).message}`);
    }
  }

  const config = loadConfig();
  const lines: string[] = [];
  if (config.statusline.chain) {
    try {
      const out = execSync(config.statusline.chain, { input: raw, encoding: "utf8", timeout: 5_000, windowsHide: true });
      if (out.trim()) lines.push(out.replace(/\s+$/, ""));
    } catch (e) {
      log(`statusline: chained command failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (config.statusline.showLine) lines.push(ownLine());
  process.stdout.write(lines.join("\n") + "\n");
}
