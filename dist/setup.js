import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, validate } from "./config.js";
import { initConfig, installDesktopMcp, installSchedule, wireClaudeSettings } from "./install.js";
import { WEEKDAYS } from "./time.js";
const DAY_NAMES = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday",
};
/** Step-by-step setup for people who'd rather answer questions than edit config. */
export async function setupWizard() {
    if (!process.stdin.isTTY)
        throw new Error("setup asks questions, so run it in a terminal. For a non-interactive install use `backburner init`.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, fallback) => (await rl.question(`${q} [${fallback}] `)).trim() || fallback;
    const yes = async (q, fallback = true) => /^y/i.test(await ask(`${q} (y/n)`, fallback ? "y" : "n"));
    const attempt = (label, fn) => {
        try {
            console.log(fn());
        }
        catch (e) {
            console.log(`Couldn't ${label}: ${e.message.split("\n")[0]}`);
        }
    };
    const pct = async (q, fallback) => {
        for (;;) {
            const n = Number(await ask(q, String(fallback)));
            if (Number.isFinite(n) && n >= 0 && n <= 100)
                return n;
            console.log("  Enter a number from 0 to 100.");
        }
    };
    try {
        console.log("Backburner setup. Press Enter to keep the value in brackets.\n");
        const { config: base } = initConfig();
        let config = structuredClone(base);
        config.timezone = await ask("Your time zone", config.timezone);
        console.log("\nHow much of your weekly usage do you use yourself on a typical day (chat, coursework, quick questions)?");
        const sameEveryWeekday = await yes("Same amount Monday to Friday?");
        if (sameEveryWeekday) {
            const weekday = await pct("  Weekdays, % per day", config.reserves.mon);
            const weekend = await pct("  Saturday and Sunday, % per day", config.reserves.sat);
            for (const d of WEEKDAYS)
                config.reserves[d] = d === "sat" || d === "sun" ? weekend : weekday;
        }
        else {
            for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
                config.reserves[d] = await pct(`  ${DAY_NAMES[d]}, %`, config.reserves[d]);
            }
        }
        config.weeklyCap = await pct("\nHighest weekly % the queue may take you to (your emergency buffer is the rest)", config.weeklyCap);
        const release = Number(await ask("Hour (0-23) when today's unused reserve goes to the queue", String(config.releaseHour)));
        if (Number.isInteger(release) && release >= 0 && release <= 23)
            config.releaseHour = release;
        const errors = validate(config);
        if (errors.length) {
            console.log(`\n${errors.join("\n")}\nKeeping your previous settings. Run setup again to fix them.`);
            config = loadConfig();
        }
        else
            saveConfig(config);
        const wired = wireClaudeSettings(config);
        saveConfig(wired.config);
        if (wired.result.changed)
            console.log(`\nHooked into Claude Code's status line${wired.result.backup ? ` (backup: ${wired.result.backup})` : ""}.`);
        if (await yes("\nRun the queue in the background every 10 minutes?"))
            attempt("set up the background schedule", () => installSchedule());
        if (await yes("Let regular Claude Desktop chats queue tasks?")) {
            attempt("add Backburner to Claude Desktop", () => `Added to ${installDesktopMcp().file}. Quit and reopen Claude Desktop to load it.`);
        }
        console.log(`
Last step: add the toggle and /queue commands to Claude Code. In a terminal, run:

  claude plugin marketplace add MeagerPotato/backburner
  claude plugin install backburner@backburner

In the Desktop app: + next to the prompt box, Plugins, Add marketplace "MeagerPotato/backburner", Add plugin.

Then try: backburner add "Summarize this week's AI news with links" --size small`);
    }
    finally {
        rl.close();
    }
}
