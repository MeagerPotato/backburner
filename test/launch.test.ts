import { describe, expect, it } from "vitest";
import { launch } from "../src/runner.js";

describe("launch", () => {
  const win = process.platform === "win32";

  it("starts an .exe directly, with its args untouched", () => {
    const c = launch("C:\\Program Files\\claude.exe", ["--allowedTools", "Bash(npm test:*)"]);
    expect(c).toEqual({ file: "C:\\Program Files\\claude.exe", args: ["--allowedTools", "Bash(npm test:*)"], shell: false });
  });

  it.runIf(win)("joins a quoted command line for .cmd shims instead of passing args with shell", () => {
    const c = launch("C:\\Users\\a b\\npm\\claude.cmd", ["-p", "Bash(npm test:*)"]);
    expect(c).toEqual({ file: '"C:\\Users\\a b\\npm\\claude.cmd" -p "Bash(npm test:*)"', args: [], shell: true });
  });

  it.runIf(!win)("never uses a shell off Windows", () => {
    expect(launch("claude", ["-p"])).toEqual({ file: "claude", args: ["-p"], shell: false });
  });
});
