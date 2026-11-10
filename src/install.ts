import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, type Config } from "./config.js";
import { claudeSettingsPath, home, paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";

const TASK_NAME = "Backburner";
const STATUSLINE_CMD = "backburner statusline";
const HOOK_CMD = "backburner hook prompt";

/** Absolute path of this package's CLI entry, so schedulers don't depend on PATH. */
export function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export function which(cmd: string): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
    const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // On Windows, npm also drops an extensionless shell script next to the .cmd shim; skip it.
    if (process.platform === "win32") return hits.find((h) => /\.(exe|cmd|bat)$/i.test(h)) ?? hits[0];
    return hits[0];
  } catch {
    return undefined;
  }
}

/** Scheduled runs get a bare PATH, so remember where `claude` lives. */
export function pinClaudePath(config: Config): Config {
  if (config.run.claudePath !== "claude") return config;
  const found = which("claude");
  return found ? { ...config, run: { ...config.run, claudePath: found } } : config;
}

type Settings = {
  statusLine?: { type?: string; command?: string; padding?: number };
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  [k: string]: unknown;
};

export interface WireResult {
  settingsFile: string;
  backup?: string;
  chained?: string;
  changed: boolean;
}

/**
 * Points Claude Code's status line at Backburner (keeping your old one as a chained
 * command) and adds a prompt hook that tells Backburner you're active. Backs up the
 * settings file first.
 */
export function wireClaudeSettings(config: Config): { config: Config; result: WireResult } {
  const file = claudeSettingsPath();
  const settings = readJson<Settings>(file, {});
  let changed = false;
  let chained: string | undefined;

  const current = settings.statusLine?.command;
  if (current !== STATUSLINE_CMD) {
    if (current) {
      chained = current;
      config = { ...config, statusline: { ...config.statusline, chain: current } };
    }
    settings.statusLine = { type: "command", command: STATUSLINE_CMD };
    changed = true;
  }

  settings.hooks ??= {};
  const groups = (settings.hooks.UserPromptSubmit ??= []);
  if (!groups.some((g) => g.hooks?.some((h) => h.command === HOOK_CMD))) {
    groups.push({ hooks: [{ type: "command", command: HOOK_CMD }] });
    changed = true;
  }

  let backup: string | undefined;
  if (changed) {
    if (existsSync(file)) {
      backup = `${file}.backburner-backup-${Date.now()}`;
      copyFileSync(file, backup);
    }
    writeJson(file, settings);
  }
  return { config, result: { settingsFile: file, backup, chained, changed } };
}

/** Undo `wireClaudeSettings`: restore the chained status line and drop the hook. */
export function unwireClaudeSettings(config: Config): boolean {
  const file = claudeSettingsPath();
  if (!existsSync(file)) return false;
  const settings = readJson<Settings>(file, {});
  let changed = false;
  if (settings.statusLine?.command === STATUSLINE_CMD) {
    if (config.statusline.chain) settings.statusLine = { type: "command", command: config.statusline.chain };
    else delete settings.statusLine;
    changed = true;
  }
  const groups = settings.hooks?.UserPromptSubmit;
  if (groups) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command !== HOOK_CMD) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== groups[i]?.hooks.length)) {
      settings.hooks!.UserPromptSubmit = kept;
      changed = true;
    }
  }
  if (changed) writeJson(file, settings);
  return changed;
}

// ---------- background schedule ----------

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true });
}

export function installSchedule(everyMinutes = 10): string {
  const node = process.execPath;
  const cli = cliPath();
  mkdirSync(home(), { recursive: true });

  if (process.platform === "win32") {
    // wscript runs the tick with no console window flashing up every few minutes.
    const vbs = join(home(), "tick.vbs");
    const cmd = `""${node}"" ""${cli}"" tick`;
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
    run("schtasks", ["/Create", "/F", "/TN", TASK_NAME, "/SC", "MINUTE", "/MO", String(everyMinutes), "/TR", `wscript.exe "${vbs}"`]);
    return `Windows Task Scheduler task "${TASK_NAME}" runs every ${everyMinutes} minutes while you're signed in.`;
  }

  if (process.platform === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "com.backburner.tick.plist");
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.backburner.tick</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>tick</string></array>
  <key>StartInterval</key><integer>${everyMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${join(home(), "launchd.err.log")}</string>
</dict></plist>
`,
    );
    try {
      run("launchctl", ["unload", plist]);
    } catch {
      // Not loaded yet.
    }
    run("launchctl", ["load", "-w", plist]);
    return `launchd agent com.backburner.tick runs every ${everyMinutes} minutes.`;
  }

  const dir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "backburner.service"), `[Unit]\nDescription=Backburner tick\n\n[Service]\nType=oneshot\nExecStart="${node}" "${cli}" tick\n`);
  writeFileSync(
    join(dir, "backburner.timer"),
    `[Unit]\nDescription=Run Backburner every ${everyMinutes} minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${everyMinutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  );
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "backburner.timer"]);
  return `systemd user timer backburner.timer runs every ${everyMinutes} minutes.`;
}

export function uninstallSchedule(): string {
  if (process.platform === "win32") {
    try {
      run("schtasks", ["/Delete", "/F", "/TN", TASK_NAME]);
    } catch {
      return "No scheduled task found.";
    }
    return `Removed Task Scheduler task "${TASK_NAME}".`;
  }
  if (process.platform === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "com.backburner.tick.plist");
    try {
      run("launchctl", ["unload", "-w", plist]);
    } catch {
      // Already unloaded.
    }
    if (existsSync(plist)) unlinkSync(plist);
    return "Removed launchd agent.";
  }
  try {
    run("systemctl", ["--user", "disable", "--now", "backburner.timer"]);
  } catch {
    // Already disabled.
  }
  return "Disabled systemd timer.";
}

export function initConfig(): { config: Config; created: boolean } {
  const created = !existsSync(paths.config());
  const config = { ...pinClaudePath(loadConfig()), integration: { node: process.execPath, cli: cliPath() } };
  saveConfig(config);
  return { config, created };
}

// ---------- Claude Desktop chat (MCP) ----------

/** Where Claude Desktop keeps its MCP server list. */
export function desktopConfigPath(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

type DesktopConfig = { mcpServers?: Record<string, { command: string; args?: string[] }>; [k: string]: unknown };

/** Adds Backburner's MCP server to Claude Desktop so regular chats can queue tasks. */
export function installDesktopMcp(): { file: string; backup?: string } {
  const file = desktopConfigPath();
  const cfg = readJson<DesktopConfig>(file, {});
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.backburner-backup-${Date.now()}`;
    copyFileSync(file, backup);
  }
  cfg.mcpServers = { ...cfg.mcpServers, backburner: { command: process.execPath, args: [cliPath(), "mcp"] } };
  writeJson(file, cfg);
  return { file, backup };
}

export function uninstallDesktopMcp(): boolean {
  const file = desktopConfigPath();
  const cfg = readJson<DesktopConfig>(file, {});
  if (!cfg.mcpServers?.backburner) return false;
  delete cfg.mcpServers.backburner;
  writeJson(file, cfg);
  return true;
}
