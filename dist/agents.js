import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cliPath, desktopConfigPath, installDesktopMcp, uninstallDesktopMcp, unwireClaudeSettings, which, wireClaudeSettings } from "./install.js";
import { INSTRUCTIONS } from "./mcp.js";
import { claudeSettingsPath } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { codexHome } from "./usage.js";
/** The command any MCP client runs to talk to Backburner. */
function server() {
    return { command: process.execPath, args: [cliPath(), "mcp"] };
}
function backup(file) {
    if (!existsSync(file))
        return undefined;
    const copy = `${file}.backburner-backup-${Date.now()}`;
    copyFileSync(file, copy);
    return copy;
}
/** Agents that keep MCP servers in a JSON file under `mcpServers` (Gemini CLI, Cursor, Windsurf). */
function jsonMcpAgent(id, name, file, cmd) {
    return {
        id,
        name,
        what: `adds Backburner's tools to ${name}`,
        installed: () => existsSync(dirname(file())) || (cmd !== undefined && which(cmd) !== undefined),
        connected: () => Boolean(readJson(file(), {}).mcpServers?.backburner),
        connect(config) {
            const f = file();
            const cfg = readJson(f, {});
            const saved = backup(f);
            cfg.mcpServers = { ...cfg.mcpServers, backburner: server() };
            writeJson(f, cfg);
            return { config, message: `${name}: added Backburner to ${f}${saved ? ` (backup: ${saved})` : ""}. Restart ${name} to load it.` };
        },
        disconnect() {
            const f = file();
            const cfg = readJson(f, {});
            if (!cfg.mcpServers?.backburner)
                return false;
            delete cfg.mcpServers.backburner;
            writeJson(f, cfg);
            return true;
        },
    };
}
// ---------- Codex ----------
const codexConfig = () => join(codexHome(), "config.toml");
const codexSkill = () => join(codexHome(), "skills", "backburner", "SKILL.md");
/** A TOML string. Literal strings ('...') keep Windows backslashes as they are. */
export function tomlString(s) {
    return /['\r\n]/.test(s) ? JSON.stringify(s) : `'${s}'`;
}
const BLOCK_HEADER = /^\s*\[\s*mcp_servers\.(?:backburner|"backburner")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;
/** Removes Backburner's `[mcp_servers.backburner]` table (and its sub-tables) from a config.toml. */
export function removeCodexServer(toml) {
    const out = [];
    let skipping = false;
    for (const line of toml.split(/\r?\n/)) {
        if (ANY_HEADER.test(line))
            skipping = BLOCK_HEADER.test(line);
        if (!skipping)
            out.push(line);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
/** Adds (or replaces) Backburner's MCP server in a Codex config.toml. */
export function addCodexServer(toml, s = server()) {
    const block = [`[mcp_servers.backburner]`, `command = ${tomlString(s.command)}`, `args = [${s.args.map(tomlString).join(", ")}]`].join("\n");
    const rest = removeCodexServer(toml);
    return `${rest ? `${rest}\n\n` : ""}${block}\n`;
}
/** Codex reads skills from $CODEX_HOME/skills; this one tells it when and how to use Backburner. */
export function codexSkillText() {
    return `---
name: backburner
description: Queue work to run later, unattended, when the user's Claude or ChatGPT/Codex plan has spare weekly usage, and manage that queue (list, edit, retry, cancel, results, budget, presence, settings). Use when the user says queue this, do this later, put it on the backburner, when I have usage left, or asks about Backburner.
---

# Backburner

${INSTRUCTIONS}

## Tools

Use the \`backburner\` MCP server's tools: add_task, list_tasks, update_task, retry_task, cancel_task, get_result, get_budget, set_presence, get_settings, change_setting.

If those tools aren't available, run the CLI instead (it does the same things): \`backburner add "<prompt>" [--code --dir <repo>] [--priority 1-5] [--deadline YYYY-MM-DD] [--size small|medium|large] [--engine claude|codex]\`, \`backburner list\`, \`backburner edit <id> ...\`, \`backburner retry <id>\`, \`backburner remove <id>\`, \`backburner result <id>\`, \`backburner status\`, \`backburner away|active|auto\`.
`;
}
const codexAgent = {
    id: "codex",
    name: "Codex",
    what: "adds Backburner's tools and a skill to Codex, and lets the queue spend spare Codex usage",
    installed: () => which("codex") !== undefined || existsSync(codexHome()),
    connected: () => {
        try {
            return readFileSync(codexConfig(), "utf8").split(/\r?\n/).some((l) => BLOCK_HEADER.test(l));
        }
        catch {
            return false;
        }
    },
    connect(config) {
        const f = codexConfig();
        let toml = "";
        try {
            toml = readFileSync(f, "utf8");
        }
        catch {
            // No config yet.
        }
        const saved = backup(f);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, addCodexServer(toml));
        mkdirSync(dirname(codexSkill()), { recursive: true });
        writeFileSync(codexSkill(), codexSkillText());
        // Scheduled runs get a bare PATH, so remember where `codex` lives.
        const found = config.codex.path === "codex" ? which("codex") : undefined;
        const next = {
            ...config,
            engines: config.engines.includes("codex") ? config.engines : [...config.engines, "codex"],
            codex: { ...config.codex, ...(found ? { path: found } : {}) },
        };
        return {
            config: next,
            message: `Codex: added Backburner to ${f}${saved ? ` (backup: ${saved})` : ""} and a skill at ${codexSkill()}. Queued tasks can now run on Codex too.`,
        };
    },
    disconnect(config) {
        let changed = false;
        const f = codexConfig();
        try {
            const toml = readFileSync(f, "utf8");
            const next = removeCodexServer(toml);
            if (next.trimEnd() !== toml.trimEnd()) {
                writeFileSync(f, next ? `${next}\n` : "");
                changed = true;
            }
        }
        catch {
            // No config.
        }
        if (existsSync(codexSkill())) {
            rmSync(dirname(codexSkill()), { recursive: true, force: true });
            changed = true;
        }
        if (config.engines.includes("codex"))
            changed = true;
        return changed;
    },
};
// ---------- Claude ----------
const claudeCodeAgent = {
    id: "claude-code",
    name: "Claude Code",
    what: "reads usage from Claude Code's status line and notices when you're typing",
    installed: () => which("claude") !== undefined || existsSync(dirname(claudeSettingsPath())),
    connected: () => readJson(claudeSettingsPath(), {}).statusLine?.command === "backburner statusline",
    connect(config) {
        const { config: next, result } = wireClaudeSettings(config);
        const message = result.changed
            ? `Claude Code: hooked into the status line${result.backup ? ` (backup: ${result.backup})` : ""}${result.chained ? `; your old status line still runs first` : ""}.`
            : "Claude Code: already hooked in.";
        return { config: next, message };
    },
    disconnect: (config) => unwireClaudeSettings(config),
};
const claudeDesktopAgent = {
    id: "claude-desktop",
    name: "Claude Desktop",
    what: "lets regular Claude chats queue and manage tasks",
    installed: () => existsSync(dirname(desktopConfigPath())),
    connected: () => Boolean(readJson(desktopConfigPath(), {}).mcpServers?.backburner),
    connect(config) {
        const { file, backup: saved } = installDesktopMcp();
        return { config, message: `Claude Desktop: added Backburner to ${file}${saved ? ` (backup: ${saved})` : ""}. Quit and reopen it to load it.` };
    },
    disconnect: () => uninstallDesktopMcp(),
};
export const AGENTS = [
    claudeCodeAgent,
    claudeDesktopAgent,
    codexAgent,
    jsonMcpAgent("gemini", "Gemini CLI", () => join(homedir(), ".gemini", "settings.json"), "gemini"),
    jsonMcpAgent("cursor", "Cursor", () => join(homedir(), ".cursor", "mcp.json")),
    jsonMcpAgent("windsurf", "Windsurf", () => join(homedir(), ".codeium", "windsurf", "mcp_config.json")),
];
export function findAgent(id) {
    const key = id.toLowerCase().replace(/\s+/g, "-");
    return AGENTS.find((a) => a.id === key || a.name.toLowerCase().replace(/\s+/g, "-") === key || (key === "claude" && a.id === "claude-code"));
}
/** Disconnects one agent and keeps the config in step (Codex leaves the engine list). */
export function disconnectAgent(a, config) {
    const changed = a.disconnect(config);
    if (a.id !== "codex" || !config.engines.includes("codex"))
        return { config, changed };
    const engines = config.engines.filter((e) => e !== "codex");
    return { config: { ...config, engines: engines.length ? engines : ["claude"] }, changed };
}
