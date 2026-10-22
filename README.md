# Backburner

Backburner paces your Claude plan's weekly usage. You hold back a daily reserve for your own chats and coursework, set a weekly cap, and queue up tasks. When there's usage to spare (overnight, while you're away, or in the last hours before your weekly reset), Backburner runs the queue with the official Claude Code CLI.

It solves three problems:

1. You don't have time to start work, so usage goes unspent.
2. A big project burns the whole week in two days and locks you out.
3. You end the week at 85% and the rest disappears at the reset.

## How the budget works

Each day has a reserve (default 5% on weekdays, 3% on weekends). The queue may spend:

```
queue budget = cap - used - reserves for later days - what's left of today's reserve
```

If you only use 2% of today's 5%, the other 3% is freed for the queue at 11pm. In the last 12 hours before the weekly reset, every reserve is freed and the queue may spend up to the cap (default 95%), so you always keep a buffer for emergencies.

Your own usage is told apart from the queue's by measuring the weekly % before and after each queued run. Chat on claude.ai, Desktop and Claude Code all count toward the same weekly pool, so Backburner sees them all.

## Install

Needs Node 20+ and Claude Code signed in with a Pro or Max plan.

```
npm install -g github:MeagerPotato/backburner
backburner init
backburner schedule install
```

`init` writes `~/.backburner/config.json` and points Claude Code's status line at Backburner, which is how it reads your usage. If you already had a status line command (a usage meter mod, for example), it keeps running and its output still shows first. Your old settings file is backed up next to the original.

`schedule install` registers a background check every 10 minutes: Windows Task Scheduler, a launchd agent on macOS, or a systemd user timer on Linux. Background runs need your computer on and signed in.

## Use

```
backburner add "Summarize the three newest papers on retrieval for code, with links"
backburner add "Add input validation to the signup form and tests for it" --code --dir ~/projects/site --priority 4 --deadline 2026-10-30 --size large
backburner list
backburner status
backburner away          # or: active, auto
```

Research tasks can search the web and read files, and their reports land in `~/.backburner/results/`. Coding tasks (`--code`) run in a fresh git worktree on a `backburner/...` branch. Backburner commits the changes, and if the repo has a GitHub remote and you have the `gh` CLI, it pushes the branch and opens a draft PR. Your own checkout is never touched.

Tasks run in order of deadline, then priority (1 to 5), then age. A task only starts if its estimate fits the budget. Estimates start from the size you pick (small ~1%, medium ~3%, large ~8% of a week) and switch to the median of your own finished runs once there are three of a size.

### Presence

- `active`: the queue only starts a task if your 5-hour window is under 50% used, so it doesn't crowd you out.
- `away`: the queue runs freely within the budget.
- `auto` (default): you count as away once you haven't sent a Claude Code prompt and haven't touched the keyboard or mouse for 30 minutes.

## Settings

```
backburner config                         # print everything
backburner config set reserves.sat 2
backburner config set weeklyCap 95
backburner config set releaseHour 23
backburner config set sweepHours 12
backburner config set presence.idleMinutes 30
backburner config set fiveHour.maxWhileActive 50
backburner config set timezone America/Los_Angeles
backburner config set run.model sonnet
```

## Terms of service

Backburner is built to stay inside Anthropic's rules for subscription use:

- It runs the unmodified `claude` binary and never calls the model any other way.
- It never reads your Claude login token or session cookie. Usage comes from the numbers Claude Code itself passes to status line commands and prints in its `stream-json` output.
- It runs on your machine, for your own account. There's no hosted version.

Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) can change, so read them yourself. Advertised plan limits "assume ordinary, individual usage."

## Uninstall

```
backburner uninstall     # restores your status line, removes the hook and the schedule
npm uninstall -g backburner-cc
```

## Roadmap

- An Active / Away / Auto toggle drawn in Claude Desktop's Code tab, plus `/queue` and `/away` commands (a Claude Code mod)
- An optional pace guard that warns when a session is eating into future days' reserves
- Adding tasks from regular Claude chat through a local MCP server
- Task sizing by Haiku when you add a task

## License

MIT
