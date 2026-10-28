# Backburner

[![CI](https://github.com/MeagerPotato/backburner/actions/workflows/ci.yml/badge.svg)](https://github.com/MeagerPotato/backburner/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Windows, macOS, Linux](https://img.shields.io/badge/os-windows%20%7C%20macos%20%7C%20linux-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

Backburner paces your AI plan's weekly usage so you use all of it without getting locked out early. It works with Claude (through Claude Code) and ChatGPT (through Codex), on their own or both at once.

You set aside a small daily reserve for your own chats, set a weekly cap, and queue up tasks. When there's usage to spare (overnight, while you're away, or in the last hours before your weekly reset), Backburner runs the queue for you with the official Claude Code or Codex CLI. You don't have to come back and type "continue": the queue keeps going on its own until the budget runs out, then picks up again when there's room.

It solves three problems:

1. You don't have time to start work, so usage goes unspent.
2. A big project burns the whole week in two days and locks you out.
3. You end the week at 85% and the rest disappears at the reset.

## Contents

- [What it is](#what-it-is)
- [How it works](#how-it-works)
- [Package details](#package-details)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [How the budget works](#how-the-budget-works)
- [Queueing tasks](#queueing-tasks)
- [The Claude Code mod](#the-claude-code-mod)
- [Letting Claude manage it](#letting-claude-manage-it)
- [Codex and other AI tools](#codex-and-other-ai-tools)
- [Presence](#presence)
- [Pace guard](#pace-guard)
- [Command reference](#command-reference)
- [Settings reference](#settings-reference)
- [Where things live](#where-things-live)
- [Troubleshooting](#troubleshooting)
- [Terms of service](#terms-of-service)
- [Uninstall](#uninstall)
- [Development](#development)

## What it is

Backburner is a small command line program that runs on your own computer, next to Claude Code or Codex. It isn't an official feature or add-on of either. It has three parts, and only the first is required:

| Part | What it does | Installed by |
| --- | --- | --- |
| **CLI and background job** | Tracks your weekly usage, holds the queue, and every 10 minutes decides whether to run the next task with `claude -p` or `codex exec`. | The installer, or `npm install -g` and `backburner setup` |
| **Claude Code mod** (optional) | Adds an Active / Away / Auto toggle and a budget line above the prompt in Claude Code (terminal and the Desktop app's Code tab), plus `/queue` commands. | `claude plugin install` |
| **Agent connections** (optional) | An MCP server that lets your AI tools run Backburner for you: queue, edit, retry and cancel tasks, read results, set presence and change settings. Works with Claude Desktop chats, Codex, Gemini CLI, Cursor and Windsurf. | `backburner setup`, or `backburner connect <agent>` |

Everything stays on your machine. There is no server and no account to create.

## How it works

1. **Reading usage.** Claude Code passes your plan's weekly and 5-hour usage to its status line command. (Codex writes the same two numbers into its session logs, and Backburner reads them from there. See [Codex and other AI tools](#codex-and-other-ai-tools).) `backburner init` makes Backburner that command (your old one still runs and shows first), so every Claude Code session hands it fresh numbers. `backburner probe` gets a reading on demand by starting a tiny Haiku request and stopping it before the model answers.
2. **Working out a budget.** Backburner subtracts your weekly cap, today's reserve and every later day's reserve from what's left of the week. Whatever remains is what the queue may spend. See [How the budget works](#how-the-budget-works).
3. **Knowing whether you're around.** A prompt hook records each Claude Code prompt you send, and in `auto` mode Backburner also checks keyboard and mouse idle time. When you're active it holds back so it doesn't eat into your 5-hour window.
4. **Running a task.** Every 10 minutes the background job runs `backburner tick`. If the next task's estimate fits the budget, it starts the regular `claude` CLI headless (`claude -p --output-format stream-json --permission-mode dontAsk`) with only the tools that kind of task may use, and sends the prompt on stdin. With Codex, it runs `codex exec` in a read-only sandbox for research and a workspace-only sandbox for code.
5. **Saving the result.** The final answer goes to `~/.backburner/results/<task id>/<run id>.md`, with the full run transcript next to it as `.jsonl`. Coding tasks commit to a new branch in a git worktree and can open a draft PR.
6. **Learning.** Backburner reads the weekly % before and after each run, records what the task actually cost, and uses your own medians for future estimates (kept separately for each plan).

## Package details

| | |
| --- | --- |
| Package name | `backburner-cc` (installs the `backburner` command) |
| Version | 0.3.0 |
| Where to get it | This GitHub repo. It isn't published to the npm registry, so install from the archive URL below. |
| Runtime | Node.js 20 or newer, with no runtime dependencies |
| Platforms | Windows 10/11, macOS, Linux |
| Claude Code mod | Plugin `backburner` in the marketplace `MeagerPotato/backburner` (the `plugin/` folder): the prompt band, slash commands, Backburner's tools and the `manage-queue` skill |
| Agent connections | A stdio MCP server built into the CLI (`backburner mcp`), added to each AI tool by `backburner connect`; Codex also gets a `backburner` skill |
| Installers | `install.sh` (macOS, Linux) and `install.ps1` (Windows) in this repo |
| License | MIT |

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [Git](https://git-scm.com), for coding tasks (they run in git worktrees)
- At least one of:
  - [Claude Code](https://code.claude.com), signed in with a Claude Pro or Max plan
  - [Codex CLI](https://github.com/openai/codex), signed in with a ChatGPT Plus, Pro, Business or Enterprise plan
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in, if you want coding tasks to open draft pull requests

Works on Windows, macOS and Linux.

## Install

One line. The installer checks for Node.js, installs the `backburner` command, and starts `backburner setup`, which finds the AI tools on your computer and asks which ones to connect.

**macOS or Linux:**

```
curl -fsSL https://raw.githubusercontent.com/MeagerPotato/backburner/main/install.sh | sh
```

**Windows (PowerShell):**

```
irm https://raw.githubusercontent.com/MeagerPotato/backburner/main/install.ps1 | iex
```

On Windows, if Node.js is missing, the installer offers to install it with `winget`. On macOS and Linux it tells you where to get it.

Prefer to do it yourself? This is all the installer does:

```
npm install -g https://github.com/MeagerPotato/backburner/archive/refs/heads/main.tar.gz
backburner setup
```

`setup` finds Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor and Windsurf, asks which plans the queue may spend (Claude, ChatGPT through Codex, or both), then asks a few short questions (time zone, daily reserves, weekly cap, release hour). It then:

1. Writes `~/.backburner/config.json`.
2. Points Claude Code's status line at Backburner, which is how it reads your Claude usage. If you already had a status line (a usage meter, for example), it keeps running and its output still shows first. Your old settings file is backed up next to the original.
3. Adds a prompt hook so Backburner knows when you're using Claude Code.
4. Connects each AI tool you say yes to, so you can manage the queue by asking it (see [Codex and other AI tools](#codex-and-other-ai-tools)). Every file it changes is backed up first.
5. Registers the background job: Windows Task Scheduler, a launchd agent on macOS, or a systemd user timer on Linux.

If you use Claude Code, add the mod too. From any terminal:

```
claude plugin marketplace add MeagerPotato/backburner
claude plugin install backburner@backburner
```

Inside a Claude Code terminal session, `/plugin marketplace add MeagerPotato/backburner` and then `/plugin install backburner@backburner` do the same. Start a new session afterwards so the mod loads.

In the Claude Desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `MeagerPotato/backburner`, then **Add plugin**.

To update later, run the installer (or the `npm install -g` command) again. Your settings and queue are kept.

<details>
<summary>Install step by step instead of with the wizard</summary>

```
backburner init                 # config, status line and prompt hook (Claude Code)
backburner connect codex        # optional: run tasks on Codex, and give it Backburner's tools
backburner connect claude-desktop   # optional: chat connector for Claude Desktop
backburner schedule install     # background job every 10 minutes
backburner config set reserves.mon 5
backburner config set weeklyCap 95
```

</details>

## Quick start

1. Open Claude Code or Codex once so Backburner gets its first usage reading (or run `backburner probe`).
2. Check the numbers:

   ```
   $ backburner status
   Weekly usage    62% of plan (read 0 min ago), resets Fri 1:57 PM
   5-hour window   12%, resets Wed 8:53 AM
   Cap             95%
   Today           reserve 5%, you've used 0%, still held 5%
   Later days      7.9% held
   Queue budget    20.1%
   Presence        away (auto: idle for 30+ min)
   Queue           2 task(s), about 4% estimated
   Next step       run 42fed6 "Add tests for the signup form"
   ```

3. Queue something:

   ```
   backburner add "Summarize this week's AI news with links" --size small
   backburner add "Add tests for the signup form" --code --dir ~/projects/site --priority 4 --deadline 2026-11-02
   ```

4. Walk away. The background job starts tasks when the budget allows. Check back with `backburner list --all` and read results in `~/.backburner/results/`.

## How the budget works

Each day has a reserve for your own use (default 5% of the week on weekdays, 3% on weekends). The queue may spend:

```
queue budget = cap - used - reserves for later days - what's left of today's reserve
```

- **Daily release.** If you only use 2% of today's 5%, the other 3% goes to the queue at the release hour (default 11pm).
- **Final sweep.** In the last 12 hours before your weekly reset, every reserve is freed and the queue may spend up to the cap.
- **Cap.** The queue never takes you past the cap (default 95%), so you always keep a buffer for emergencies.
- **Your use vs. the queue's.** Backburner measures the weekly % before and after each queued run. Everything else is counted as yours. Chat on claude.ai, the Desktop app and Claude Code all share the same weekly pool, so it sees them all.

Example: your week resets Sunday night. It's Wednesday, you're at 40%, the cap is 95%, and Thursday through Sunday hold 5 + 5 + 3 + 3 = 16%. You've used 1% of today's 5%, so 4% is still held. The queue may spend 95 - 40 - 16 - 4 = 35%.

## Queueing tasks

```
backburner add "<prompt>" [--title <text>] [--dir <path>] [--code] [--priority 1-5] [--deadline YYYY-MM-DD] [--size small|medium|large] [--engine claude|codex|any]
```

Write the prompt so it stands on its own. The run has no memory of your other conversations.

**Research tasks** (the default) can search the web and read files in `--dir` (default: the folder you ran the command in). The report is saved to `~/.backburner/results/<task id>/`.

**Coding tasks** (`--code`) run in a fresh git worktree on a new `backburner/<name>-<id>` branch, so your own checkout is never touched. Backburner commits the changes, and if the repo has a GitHub remote and `gh` is signed in, it pushes the branch and opens a draft pull request. Claude may edit files and run `npm test` and `npm run`, but not other shell commands. Codex may edit files and run commands inside the worktree only, with no network.

**Which plan.** With more than one plan turned on, a task runs on whichever plan has room, so spare Codex usage picks up when Claude's is spent and the other way round. Pin a task with `--engine claude` or `--engine codex`.

**Order.** Tasks run by earliest deadline, then highest priority (1 low to 5 high), then oldest first. A task starts only if its estimate fits the current budget.

**Estimates.** Each size starts with a guess: small is about 1% of the week and 10 minutes, medium about 3% and 30 minutes, large about 8% and 90 minutes. Once you've finished three tasks of a size, Backburner uses the median of your own runs instead.

**Limits.** If a run hits a usage limit, the task goes back in the queue without counting as an attempt. A task that fails twice is marked failed. Runs time out after 60 minutes.

Manage the queue with `backburner list`, `backburner list --all` and `backburner remove <id>` (the first few characters of the id are enough).

## The Claude Code mod

With the mod installed, a line above the prompt shows:

```
Backburner [Active] [Away] [Auto: away]  week 62% · queue can spend 20.1% · 2 queued · resets Fri 1:57 PM
```

Click a button to change your presence. The mod also adds these commands:

| Command | What it does |
| --- | --- |
| `/queue <prompt>` | Queue a research task in the current folder |
| `/queue-code <prompt>` | Queue a coding task in the current repo |
| `/away`, `/active`, `/auto` | Set your presence |
| `/backburner` | Open a pane with the full budget breakdown and the queue, with Cancel buttons |

In the Desktop app, where the status line doesn't run, the mod is also what feeds Backburner your latest usage numbers. It needs `backburner init` (or `setup`) to have run first, since it calls the CLI.

## Letting Claude manage it

You don't have to run Backburner's commands yourself. Once it's connected, ask Claude in plain words and it handles the queue, presence and settings for you.

**Regular Claude Desktop chats** use the chat connector:

```
backburner desktop install
```

This adds Backburner as an MCP server in Claude Desktop (your old config is backed up first). Quit and reopen the app. The connector tells Claude what Backburner is and how to use it when the chat starts, so you don't need to explain anything.

**Claude Code** (terminal, and the Desktop app's Code tab) gets the same tools from the mod, plus the `manage-queue` skill that tells Claude when and how to use them. Claude reads it when your request is about Backburner and manages the queue for you, with no shell commands to approve.

Things you can say in either place:

| You say | Claude does |
| --- | --- |
| "Put this on the backburner: compare the three cheapest flights from SFO to Taipei in late December." | Writes a prompt that stands on its own, picks a size, and queues it |
| "Queue a fix for the flaky signup test in this repo, due Friday." | Queues a coding task in the repo with a deadline |
| "Make the flights one high priority." / "Change it to small." | Edits the queued task |
| "What's in the queue?" / "Why hasn't anything run?" | Lists tasks, or shows the budget and the reason the next task is waiting |
| "What did the flights task find?" | Reads the finished report and summarizes it |
| "That one failed, try it again." | Puts it back in the queue |
| "I'm heading to bed." / "I'm back." | Sets presence to away or active |
| "Hold back only 2% on weekends." / "Raise the cap to 97%." | Changes `reserves.sat`, `reserves.sun` or `weeklyCap` |

The chat connector's tools are `add_task`, `list_tasks`, `update_task`, `retry_task`, `cancel_task`, `get_result`, `get_budget`, `set_presence`, `get_settings` and `change_setting`. For safety, chat can't change the tools a queued run may use (`run.researchTools`, `run.codeTools`) or the path to the `claude` CLI; change those in a terminal. Coding tasks from chat need the repo's full path.

## Codex and other AI tools

Backburner isn't only for Claude. Two separate things can be turned on for other tools:

1. **Spending a ChatGPT plan (Codex).** Queued tasks run with the official Codex CLI (`codex exec`), paced by your ChatGPT plan's own weekly and 5-hour limits, with the same reserves and cap as Claude.
2. **Managing the queue by asking.** Any tool that supports MCP servers gets Backburner's tools, so you can say "put this on the backburner" in that tool and it queues the task.

This is the fix for chat apps that stop when they hit a limit and wait for you to come back and say "continue". Hand the work to Backburner instead, and it runs to the end on its own, on whichever plan has usage to spare.

| Tool | Can run queued tasks | Can manage the queue | What `backburner connect` changes |
| --- | --- | --- | --- |
| Claude Code | Yes (Claude plan) | Yes, with the mod | `~/.claude/settings.json` (status line and prompt hook) |
| Claude Desktop chats | No (they share the Claude plan) | Yes | `claude_desktop_config.json` |
| Codex CLI and IDE extension | Yes (ChatGPT plan) | Yes, plus a skill | `~/.codex/config.toml` (`[mcp_servers.backburner]`) and `~/.codex/skills/backburner/SKILL.md` |
| Gemini CLI | No | Yes | `~/.gemini/settings.json` |
| Cursor | No | Yes | `~/.cursor/mcp.json` |
| Windsurf | No | Yes | `~/.codeium/windsurf/mcp_config.json` |

`backburner setup` asks about each tool it finds. You can also do it any time:

```
backburner agents                 # which tools are on this computer, and which are connected
backburner connect codex cursor   # connect some
backburner connect --all          # connect every tool found
backburner disconnect gemini      # undo one
```

Every file is backed up next to the original before Backburner changes it, and only Backburner's own entry is touched. Restart the tool after connecting it.

**How Codex usage is read.** Codex saves each session to `~/.codex/sessions/` (or `$CODEX_HOME/sessions/`), and after each model call it notes how much of the 5-hour and weekly windows you've used. Backburner reads the newest note. It never reads `auth.json` or your login. If there's no recent session, `backburner probe codex` runs a one-word request to get one.

**Using only Codex.** If you don't have Claude Code, answer no to the Claude question in `setup` (or run `backburner config set engines codex`). Everything else works the same.

**The ChatGPT website and app** can't reach programs on your computer, so they can't queue tasks for Backburner. Queue from Codex (the CLI, or the Codex extension in VS Code, Cursor or Windsurf), from any connected tool, or with `backburner add`.

## Presence

| Mode | What the queue does |
| --- | --- |
| `active` | Starts a task only if your 5-hour window is under 50%, so it doesn't crowd you out. |
| `away` | Runs freely within the budget (up to 90% of the 5-hour window). |
| `auto` (default) | Counts you as away once you haven't sent a Claude Code prompt and haven't touched the keyboard or mouse for 30 minutes. |

Presence applies to every plan. The 5-hour limits are checked against each plan's own window.

Set it with `backburner away`, `backburner active` or `backburner auto`, or with the mod's buttons. On Linux, `auto` needs `xprintidle` to see keyboard and mouse activity; without it, only Claude Code prompts count.

## Pace guard

If your own use today runs past today's reserve and starts eating into later days', the mod tells you once a day. Choose what it does:

```
backburner config set guard warn    # default: show a notice
backburner config set guard block   # hold back the first prompt that day until you send it again
backburner config set guard off     # stay quiet
```

## Command reference

| Command | What it does |
| --- | --- |
| `backburner setup` | Guided install: finds your AI tools and connects the ones you pick |
| `backburner agents` | Which AI tools are on this computer, and which are connected |
| `backburner connect <agent>...` / `--all` | Connect `claude-code`, `claude-desktop`, `codex`, `gemini`, `cursor` or `windsurf` |
| `backburner disconnect <agent>...` / `--all` | Disconnect them again |
| `backburner init` | Create the config and connect to Claude Code's status line and prompt hook |
| `backburner schedule install` / `uninstall` | Add or remove the background job |
| `backburner desktop install` / `uninstall` | Same as `connect claude-desktop` / `disconnect claude-desktop` |
| `backburner uninstall` | Disconnect every tool and remove the background job |
| `backburner status [--json]` | Budget, reserves, presence and queue, for each plan |
| `backburner add "<prompt>" [options]` | Queue a task (see [Queueing tasks](#queueing-tasks)) |
| `backburner list [--all] [--json]` | Queued tasks, or all tasks with results |
| `backburner edit <id> [options]` | Change a queued task: `--prompt`, `--title`, `--priority`, `--deadline` (`""` clears it), `--size`, `--engine claude\|codex\|any`, `--code --dir <path>` or `--research` |
| `backburner remove <id>` | Cancel a task (`cancel` works too) |
| `backburner retry <id>` | Queue a failed, cancelled or finished task again |
| `backburner result <id>` | Print a finished task's report, or its branch and PR |
| `backburner away` / `active` / `auto` | Set presence |
| `backburner config` | Print the config |
| `backburner config set <key> <value>` | Change a setting |
| `backburner tick [--dry-run]` | One scheduler pass; `--dry-run` shows what it would do |
| `backburner probe [claude\|codex]` | Read fresh usage numbers now (for Claude, a tiny Haiku call that stops before the model answers; for Codex, a one-word request) |
| `backburner log [-n 30]` | Recent activity |

## Settings reference

Change any of these with `backburner config set <key> <value>`.

| Key | Default | Meaning |
| --- | --- | --- |
| `engines` | `claude` (setup adds `codex` if you say yes) | Plans the queue may spend, comma separated, e.g. `claude,codex` |
| `timezone` | your system's | IANA time zone for day boundaries, e.g. `America/Los_Angeles` |
| `reserves.mon` ... `reserves.sun` | 5 weekdays, 3 weekends | Weekly % held each day for your own use |
| `weeklyCap` | 95 | The queue never takes weekly usage past this % |
| `releaseHour` | 23 | Local hour (0-23) when today's unused reserve goes to the queue |
| `sweepHours` | 12 | Hours before the weekly reset when all reserves are freed |
| `presence.idleMinutes` | 30 | Idle minutes before `auto` counts you as away |
| `fiveHour.maxWhileActive` | 50 | While active, start a task only if the 5-hour window is below this % |
| `fiveHour.maxWhileAway` | 90 | Same, while away |
| `estimates.small.pct` / `.minutes` | 1 / 10 | Starting estimate for small tasks (also `medium` 3 / 30, `large` 8 / 90) |
| `run.model` | Claude Code's default | Model for queued runs, e.g. `sonnet` or `opus` |
| `run.timeoutMinutes` | 60 | Stop a run after this long |
| `run.openDraftPr` | true | Push and open a draft PR after coding tasks |
| `run.claudePath` | found at setup | Full path to the `claude` CLI |
| `codex.model` | Codex's default | Model for queued Codex runs |
| `codex.search` | true | Let Codex research tasks search the web |
| `codex.path` | found at setup | Full path to the `codex` CLI |
| `guard` | `warn` | Pace guard: `off`, `warn` or `block` |
| `statusline.showLine` | true | Show Backburner's line in the Claude Code status line |

Lists such as `run.researchTools` and `run.codeTools` (the tools a queued Claude run may use) can be edited in `~/.backburner/config.json` directly. Reserves, the cap and the release hour apply to every plan.

## Where things live

Everything is in `~/.backburner/` (`%USERPROFILE%\.backburner\` on Windows). Set `BACKBURNER_HOME` to use another folder.

| File | Contents |
| --- | --- |
| `config.json` | Your settings |
| `tasks.json` | The queue and finished tasks |
| `runs.json` | Each run's start, end and usage before and after |
| `usage.json` | Recent usage readings (14 days) |
| `presence.json` | Presence mode and last activity |
| `results/` | Research reports and run logs |
| `backburner.log` | Activity log (`backburner log` shows the end of it) |

## Troubleshooting

**"No weekly usage reading yet."** Open a Claude Code session (the status line feeds Backburner) or run `backburner probe`. For Codex, run any Codex session, or `backburner probe codex`. Codex must be signed in with a ChatGPT plan; with an API key there's no weekly limit to read.

**A tool doesn't show Backburner's tools after `connect`.** Restart it. Check with `backburner agents`, and in Codex with `codex mcp list`.

**Nothing runs.** Run `backburner tick --dry-run` to see why. Common reasons: the queue is empty, the next task's estimate doesn't fit the budget, you're marked active and the 5-hour window is over 50%, or the computer was asleep. Background runs need the computer on and you signed in.

**`backburner` isn't found.** npm's global folder isn't on your PATH. Run `npm prefix -g` and add that folder (on macOS and Linux, its `bin` subfolder) to PATH.

**The mod won't install or load, or `claude plugin validate` says `"session.start" is not an event`.** Your Claude Code is too old for the mod (2.1.248 was; 2.1.309 works). Run `claude update`, or update the Desktop app.

**The mod says Backburner isn't set up.** Run `backburner init` in a terminal, then start a new Claude Code session.

**A coding task finished but there's no PR.** The repo needs an `origin` remote on GitHub and `gh auth status` must show you're signed in. The branch is still committed locally either way.

**Reports look garbled in Windows PowerShell** (for example `â€”` where a dash should be). Reports are UTF-8, and Windows PowerShell 5.1 reads files as ANSI by default. Use `Get-Content <file> -Encoding UTF8`, PowerShell 7, or open the `.md` file in an editor.

**Check the background job.** Windows: `schtasks /Query /TN Backburner`. macOS: `launchctl list | grep backburner`. Linux: `systemctl --user status backburner.timer`.

## Terms of service

Backburner is built to stay inside the providers' rules for subscription use:

- It runs the unmodified `claude` binary and never calls the model any other way.
- It never reads your Claude login token or session cookie. Usage comes from the numbers Claude Code itself passes to status line commands and prints in its `stream-json` output.
- It runs on your machine, for your own account. There's no hosted version.
- With Codex, the same holds: it runs the unmodified `codex` binary, reads usage from the session logs Codex writes, and never reads `~/.codex/auth.json`.

Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), the [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) and OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use) can change, so read them yourself. Advertised plan limits "assume ordinary, individual usage."

## Uninstall

```
backburner uninstall           # disconnects every tool (restores your status line) and removes the background job
npm uninstall -g backburner-cc
```

Then remove the mod with `claude plugin uninstall backburner@backburner` (or `/plugin uninstall backburner` inside Claude Code). Delete `~/.backburner/` to remove your queue and history.

## Development

```
git clone https://github.com/MeagerPotato/backburner
cd backburner
npm install
npm test                 # unit tests
npm run typecheck
npm run build            # compiles to dist/ (commit dist/ with your change)
npm link                 # puts your local build on PATH as `backburner`
```

The mod lives in `plugin/`. Check it with `claude plugin validate plugin` and `claude plugin test plugin`.

Set `BACKBURNER_HOME` to a scratch folder while testing so you don't touch your real queue.

The compiled `dist/` folder is committed so that installing from the GitHub archive works without a build step. CI fails if it's out of date, so run `npm run build` before you commit.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
