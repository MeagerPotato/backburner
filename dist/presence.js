import { execFileSync } from "node:child_process";
import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
export function loadPresence() {
    return readJson(paths.presence(), { mode: "auto" });
}
export function savePresence(p) {
    writeJson(paths.presence(), p);
}
export function setMode(mode) {
    const p = { ...loadPresence(), mode };
    savePresence(p);
    return p;
}
export function touchActivity(at = Date.now()) {
    savePresence({ ...loadPresence(), lastPromptAt: at });
}
const PS_IDLE = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class BBIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static uint Ms() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; }
}
'@; [BBIdle]::Ms()`;
/** Milliseconds since the last keyboard or mouse input, or undefined if the OS won't say. */
export function osIdleMs() {
    try {
        if (process.platform === "win32") {
            const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_IDLE], {
                encoding: "utf8",
                timeout: 15_000,
                windowsHide: true,
            });
            const ms = Number(out.trim().split(/\s+/).at(-1));
            return Number.isFinite(ms) ? ms : undefined;
        }
        if (process.platform === "darwin") {
            const out = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", timeout: 5_000 });
            const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
            return m ? Number(m[1]) / 1e6 : undefined;
        }
        const out = execFileSync("xprintidle", [], { encoding: "utf8", timeout: 5_000 });
        const ms = Number(out.trim());
        return Number.isFinite(ms) ? ms : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Auto mode counts you as away once both your last Claude Code prompt and your last
 * keyboard or mouse input are older than the idle limit. If the OS idle time is
 * unavailable, prompt activity alone decides.
 */
export function resolvePresence(state, idleMinutes, now, idleMs) {
    if (state.mode === "active")
        return { effective: "active", mode: "active", reason: "set to Active" };
    if (state.mode === "away")
        return { effective: "away", mode: "away", reason: "set to Away" };
    const limit = idleMinutes * 60_000;
    const sincePrompt = state.lastPromptAt ? now - state.lastPromptAt : Number.POSITIVE_INFINITY;
    if (sincePrompt < limit) {
        return { effective: "active", mode: "auto", reason: `prompted ${Math.round(sincePrompt / 60_000)} min ago` };
    }
    if (idleMs !== undefined && idleMs < limit) {
        return { effective: "active", mode: "auto", reason: `keyboard or mouse used ${Math.round(idleMs / 60_000)} min ago` };
    }
    return { effective: "away", mode: "auto", reason: `idle for ${idleMinutes}+ min` };
}
