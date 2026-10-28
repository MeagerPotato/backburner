import { homedir } from "node:os";
import { join } from "node:path";
/** Root folder for all Backburner state. Override with BACKBURNER_HOME (used by tests). */
export function home() {
    return process.env.BACKBURNER_HOME ?? join(homedir(), ".backburner");
}
export const paths = {
    config: () => join(home(), "config.json"),
    usage: () => join(home(), "usage.json"),
    tasks: () => join(home(), "tasks.json"),
    runs: () => join(home(), "runs.json"),
    presence: () => join(home(), "presence.json"),
    lock: () => join(home(), "tick.lock"),
    log: () => join(home(), "backburner.log"),
    results: () => join(home(), "results"),
    worktrees: () => join(home(), "worktrees"),
};
/** Claude Code's user settings file. */
export function claudeSettingsPath() {
    return process.env.CLAUDE_CONFIG_DIR
        ? join(process.env.CLAUDE_CONFIG_DIR, "settings.json")
        : join(homedir(), ".claude", "settings.json");
}
