import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, validate, type Config } from "./config.js";
import { AGENTS } from "./agents.js";
import { initConfig, installSchedule } from "./install.js";
import type { Provider } from "./usage.js";
import { WEEKDAYS, type Weekday } from "./time.js";

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** Step-by-step setup for people who'd rather answer questions than edit config. */
export async function setupWizard(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("setup asks questions, so run it in a terminal. For a non-interactive install use `backburner init`.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback: string) => (await rl.question(`${q} [${fallback}] `)).trim() || fallback;
  const yes = async (q: string, fallback = true) => /^y/i.test(await ask(`${q} (y/n)`, fallback ? "y" : "n"));
  const attempt = (label: string, fn: () => string) => {
    try {
      console.log(fn());
    } catch (e) {
      console.log(`Couldn't ${label}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  const pct = async (q: string, fallback: number) => {
    for (;;) {
      const n = Number(await ask(q, String(fallback)));
      if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
      console.log("  Enter a number from 0 to 100.");
    }
  };

  try {
    console.log("Backburner setup. Press Enter to keep the value in brackets.\n");
    const { config: base } = initConfig();
    let config: Config = structuredClone(base);

    const found = AGENTS.filter((a) => a.installed());
    console.log(found.length ? `Found on this computer: ${found.map((a) => a.name).join(", ")}.` : "Didn't find Claude Code, Codex or another AI tool on this computer.");
    const hasClaude = found.some((a) => a.id === "claude-code");
    const hasCodex = found.some((a) => a.id === "codex");
    const engines: Provider[] = [];
    if (hasClaude && (await yes("\nRun queued tasks on your Claude plan (with Claude Code)?"))) engines.push("claude");
    if (hasCodex && (await yes(`${hasClaude ? "" : "\n"}Run queued tasks on your ChatGPT plan (with Codex)?`))) engines.push("codex");
    if (engines.length === 0) {
      console.log("\nThe queue needs Claude Code or Codex to run tasks. Install one, sign in, then run `backburner setup` again. Keeping Claude as the default for now.");
      engines.push("claude");
    }
    config.engines = engines;

    config.timezone = await ask("Your time zone", config.timezone);

    console.log(`\nHow much of your weekly usage do you use yourself on a typical day (chat, coursework, quick questions)?${engines.length > 1 ? " The same reserve is held on each plan." : ""}`);
    const sameEveryWeekday = await yes("Same amount Monday to Friday?");
    if (sameEveryWeekday) {
      const weekday = await pct("  Weekdays, % per day", config.reserves.mon);
      const weekend = await pct("  Saturday and Sunday, % per day", config.reserves.sat);
      for (const d of WEEKDAYS) config.reserves[d] = d === "sat" || d === "sun" ? weekend : weekday;
    } else {
      for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as Weekday[]) {
        config.reserves[d] = await pct(`  ${DAY_NAMES[d]}, %`, config.reserves[d]);
      }
    }

    config.weeklyCap = await pct("\nHighest weekly % the queue may take you to (your emergency buffer is the rest)", config.weeklyCap);
    const release = Number(await ask("Hour (0-23) when today's unused reserve goes to the queue", String(config.releaseHour)));
    if (Number.isInteger(release) && release >= 0 && release <= 23) config.releaseHour = release;

    const errors = validate(config);
    if (errors.length) {
      console.log(`\n${errors.join("\n")}\nKeeping your previous settings. Run setup again to fix them.`);
      config = loadConfig();
    } else saveConfig(config);

    console.log("\nConnect Backburner to your AI tools so you can queue and manage tasks by asking them.");
    for (const a of found) {
      if (!(await yes(`  ${a.name}: ${a.what}?`))) continue;
      try {
        const r = a.connect(config);
        config = r.config;
        console.log(`  ${r.message}`);
      } catch (e) {
        console.log(`  Couldn't connect ${a.name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    // Connecting Codex turns on its plan; keep the answer given above.
    config.engines = engines;
    saveConfig(config);

    if (await yes("\nRun the queue in the background every 10 minutes?")) attempt("set up the background schedule", () => installSchedule());

    const example = 'backburner add "Summarize this week\'s AI news with links" --size small';
    if (!hasClaude) {
      console.log(`\nDone. Try: ${example}\nOr ask ${found.find((a) => a.id !== "claude-desktop")?.name ?? "your AI tool"} to "put this on the backburner".`);
      return;
    }
    console.log(`
Last step: add the toggle and /queue commands to Claude Code. In a terminal, run:

  claude plugin marketplace add MeagerPotato/backburner
  claude plugin install backburner@backburner

In the Desktop app: + next to the prompt box, Plugins, Add marketplace "MeagerPotato/backburner", Add plugin.

Then try: ${example}`);
  } finally {
    rl.close();
  }
}
