# Backburner

[![CI](https://github.com/MeagerPotato/backburner/actions/workflows/ci.yml/badge.svg)](https://github.com/MeagerPotato/backburner/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Windows, macOS, Linux](https://img.shields.io/badge/os-windows%20%7C%20macos%20%7C%20linux-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

Backburner paces your Claude plan's weekly usage so you use all of it without getting locked out early.

You set aside a small daily reserve for your own chats, set a weekly cap, and queue up tasks. When there's usage to spare (overnight, while you're away, or in the last hours before your weekly reset), Backburner runs the queue for you with the official Claude Code CLI.

It solves three problems:

1. You don't have time to start work, so usage goes unspent.
2. A big project burns the whole week in two days and locks you out.
3. You end the week at 85% and the rest disappears at the reset.

## Contents

- [What it is](#what-it-is)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [How the budget works](#how-the-budget-works)
- [Queueing tasks](#queueing-tasks)
- [The Claude Code mod](#the-claude-code-mod)
- [Queueing from regular Claude chat](#queueing-from-regular-claude-chat)
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

Backburner is a small command line program that runs on your own computer, next to Claude Code. It isn't a Claude feature or an official add-on. It has three parts, and only the first is required:

| Part | What it does | Installed by |
| --- | --- | --- |
| **CLI and background job** | Tracks your weekly usage, holds the queue, and every 10 minutes decides whether to run the next task with `claude -p`. | `npm install -g` and `backburner setup` |
| **Claude Code mod** (optional) | Adds an Active / Away / Auto toggle and a budget line above the prompt in Claude Code (terminal and the Desktop app's Code tab), plus `/queue` commands. | `/plugin install` |
| **Chat connector** (optional) | An MCP server that lets regular Claude Desktop chats add, list and cancel tasks. | `backburner desktop install` |

Everything stays on your machine. There is no server and no account to create.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [Git](https://git-scm.com) (npm uses it to install from GitHub, and coding tasks use worktrees)
- [Claude Code](https://code.claude.com) installed and signed in with a Pro or Max plan
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in, if you want coding tasks to open draft pull requests

Works on Windows, macOS and Linux.

## Install

```
npm install -g github:MeagerPotato/backburner
backburner setup
```

`setup` asks five short questions (time zone, daily reserves, weekly cap, release hour, and whether to add the background job and chat connector), then:

1. Writes `~/.backburner/config.json`.
2. Points Claude Code's status line at Backburner, which is how it reads your usage. If you already had a status line (a usage meter, for example), it keeps running and its output still shows first. Your old settings file is backed up next to the original.
3. Adds a prompt hook so Backburner knows when you're using Claude Code.
4. Registers the background job: Windows Task Scheduler, a launchd agent on macOS, or a systemd user timer on Linux.
5. Optionally adds the chat connector to Claude Desktop.

Then add the mod. In a Claude Code terminal session, type:

```
/plugin install backburner --marketplace MeagerPotato/backburner
```

In the Claude Desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `MeagerPotato/backburner`, then **Add plugin**.

<details>
<summary>Install step by step instead of with the wizard</summary>

```
backburner init                 # config, status line and prompt hook
backburner schedule install     # background job every 10 minutes
backburner desktop install      # optional: chat connector
backburner config set reserves.mon 5
backburner config set weeklyCap 95
```

</details>

## Quick start

1. Open Claude Code once so Backburner gets its first usage reading (or run `backburner probe`).
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
backburner add "<prompt>" [--title <text>] [--dir <path>] [--code] [--priority 1-5] [--deadline YYYY-MM-DD] [--size small|medium|large]
```

Write the prompt so it stands on its own. The run has no memory of your other conversations.

**Research tasks** (the default) can search the web and read files in `--dir` (default: the folder you ran the command in). The report is saved to `~/.backburner/results/<task id>/`.

**Coding tasks** (`--code`) run in a fresh git worktree on a new `backburner/<name>-<id>` branch, so your own checkout is never touched. Backburner commits the changes, and if the repo has a GitHub remote and `gh` is signed in, it pushes the branch and opens a draft pull request. Claude may edit files and run `npm test` and `npm run`, but not other shell commands.

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

## Queueing from regular Claude chat

```
backburner desktop install
```

This adds Backburner as an MCP server in Claude Desktop (your old config is backed up first). Quit and reopen the app. Then, in any chat:

> Queue a research task for Backburner: compare the three cheapest flights from SFO to Taipei in late December.

Claude writes a prompt that stands on its own, picks a size, and adds it. You can also ask it to list tasks, cancel one, or show your budget. Coding tasks from chat need the repo's full path.

## Presence

| Mode | What the queue does |
| --- | --- |
| `active` | Starts a task only if your 5-hour window is under 50%, so it doesn't crowd you out. |
| `away` | Runs freely within the budget (up to 90% of the 5-hour window). |
| `auto` (default) | Counts you as away once you haven't sent a Claude Code prompt and haven't touched the keyboard or mouse for 30 minutes. |

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
| `backburner setup` | Guided install |
| `backburner init` | Create the config and connect to Claude Code's status line and prompt hook |
| `backburner schedule install` / `uninstall` | Add or remove the background job |
| `backburner desktop install` / `uninstall` | Add or remove the Claude Desktop chat connector |
| `backburner uninstall` | Undo `init`, remove the background job and the chat connector |
| `backburner status [--json]` | Budget, reserves, presence and queue |
| `backburner add "<prompt>" [options]` | Queue a task (see [Queueing tasks](#queueing-tasks)) |
| `backburner list [--all] [--json]` | Queued tasks, or all tasks with results |
| `backburner remove <id>` | Cancel a task (`cancel` works too) |
| `backburner away` / `active` / `auto` | Set presence |
| `backburner config` | Print the config |
| `backburner config set <key> <value>` | Change a setting |
| `backburner tick [--dry-run]` | One scheduler pass; `--dry-run` shows what it would do |
| `backburner probe` | Read fresh usage numbers now (a tiny Haiku call that stops before the model answers) |
| `backburner log [-n 30]` | Recent activity |

## Settings reference

Change any of these with `backburner config set <key> <value>`.

| Key | Default | Meaning |
| --- | --- | --- |
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
| `guard` | `warn` | Pace guard: `off`, `warn` or `block` |
| `statusline.showLine` | true | Show Backburner's line in the Claude Code status line |

Lists such as `run.researchTools` and `run.codeTools` (the tools a queued run may use) can be edited in `~/.backburner/config.json` directly.

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

**"No weekly usage reading yet."** Open a Claude Code session (the status line feeds Backburner) or run `backburner probe`.

**Nothing runs.** Run `backburner tick --dry-run` to see why. Common reasons: the queue is empty, the next task's estimate doesn't fit the budget, you're marked active and the 5-hour window is over 50%, or the computer was asleep. Background runs need the computer on and you signed in.

**`backburner` isn't found.** npm's global folder isn't on your PATH. Run `npm prefix -g` and add that folder (on macOS and Linux, its `bin` subfolder) to PATH.

**The mod says Backburner isn't set up.** Run `backburner init` in a terminal, then start a new Claude Code session.

**A coding task finished but there's no PR.** The repo needs an `origin` remote on GitHub and `gh auth status` must show you're signed in. The branch is still committed locally either way.

**Check the background job.** Windows: `schtasks /Query /TN Backburner`. macOS: `launchctl list | grep backburner`. Linux: `systemctl --user status backburner.timer`.

## Terms of service

Backburner is built to stay inside Anthropic's rules for subscription use:

- It runs the unmodified `claude` binary and never calls the model any other way.
- It never reads your Claude login token or session cookie. Usage comes from the numbers Claude Code itself passes to status line commands and prints in its `stream-json` output.
- It runs on your machine, for your own account. There's no hosted version.

Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) can change, so read them yourself. Advertised plan limits "assume ordinary, individual usage."

## Uninstall

```
backburner uninstall           # restores your status line, removes the hook, the background job and the chat connector
npm uninstall -g backburner-cc
```

Then, in Claude Code, `/plugin uninstall backburner`. Delete `~/.backburner/` to remove your queue and history.

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

The compiled `dist/` folder is committed so that `npm install -g github:MeagerPotato/backburner` works without a build step. CI fails if it's out of date, so run `npm run build` before you commit.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
