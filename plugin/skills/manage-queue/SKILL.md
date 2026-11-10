---
name: manage-queue
description: Manage the user's Backburner queue and usage budget with Backburner's tools (or its CLI). Use when the user wants to queue work for later ("put this on the backburner", "do this overnight", "run this when I have usage left"), check, edit, retry or cancel queued tasks, read a finished task's report, say they're stepping away or back, ask how much weekly Claude usage they have left, or change Backburner's reserves, cap or other settings.
---

# Backburner

Backburner runs on the user's computer and paces their Claude plan's weekly usage. It holds a daily reserve for the user's own chats, never lets queued work push weekly usage past a cap (default 95%), and runs queued tasks unattended with `claude -p` when there's usage to spare. A background job checks every 10 minutes, so nothing starts the moment it's queued.

Handle requests yourself. Don't hand the user commands to run unless something is broken.

## Tools

The mod gives you Backburner's own tools, named `mcp__backburner__<name>` (load them with ToolSearch if they aren't listed yet): `add_task`, `list_tasks`, `update_task`, `retry_task`, `cancel_task`, `get_result`, `get_budget`, `set_presence`, `get_settings` and `change_setting`. Prefer them: they need no shell and no quoting. Use the `backburner` commands below when the tools aren't there, or for things they don't cover (`tick --dry-run`, `log`, `probe`).

## Queue a task

```
backburner add "<prompt>" --title "<short title>" --size small|medium|large [--priority 1-5] [--deadline YYYY-MM-DD]
backburner add "<prompt>" --code --dir "<absolute repo path>" --size medium
```

- The run can't see this conversation. Write a prompt that stands alone: goal, all relevant details, constraints, and the shape of the output.
- Research tasks (default) can search the web and read files in `--dir` (default: the current folder). They end in a markdown report.
- `--code` tasks edit a git repo in a fresh worktree on a `backburner/...` branch, commit, and open a draft PR if `gh` is signed in. Use the current repo's absolute path unless the user names another.
- Size: small (~1% of the week, ~10 min) for a quick lookup or one-file tweak, medium (~3%, ~30 min) for a researched summary or focused change, large (~8%, ~90 min) for deep research or a multi-file feature. Choose it yourself.
- Priority defaults to 3. Only set a deadline the user gave. Order: earliest deadline, then priority, then oldest.
- Quote the prompt for the shell you're in. On Windows PowerShell, prefer single quotes and double any single quote inside.
- Afterwards, tell the user the id, title and estimate from the output.

## Check and manage

| Want | Command |
| --- | --- |
| Queue | `backburner list` (`--all` includes finished; `--json` for details) |
| Budget, presence, next step | `backburner status` (`--json` available) |
| Why nothing ran | `backburner tick --dry-run`, then `backburner log -n 30` |
| Change a queued task | `backburner edit <id> [--prompt ...] [--title ...] [--priority N] [--deadline YYYY-MM-DD or ""] [--size ...] [--code --dir <path> or --research]` |
| Cancel | `backburner remove <id>` |
| Run a failed, cancelled or finished task again | `backburner retry <id>` |
| Read what a task produced | `backburner result <id>` (the report, or the branch and PR) |
| Fresh usage numbers | `backburner probe` |

Ids can be shortened to any unique prefix. When a task finishes, summarize its report for the user rather than pasting all of it.

## Presence

When the user says they're leaving, going to bed, or want the queue to start, set presence to away (`set_presence`, or `backburner away`) in the same turn, without asking. Set it to active while they're working and want the queue held back, and back to auto (the default, which decides from idle time) when they ask. Presence only changes how much of the 5-hour window the queue may use; the weekly budget always applies.

## Settings

`backburner config` prints them. `backburner config set <key> <value>` changes one:

- `reserves.mon` ... `reserves.sun`: weekly % held each day for the user (default 5 weekdays, 3 weekends)
- `weeklyCap` (95), `releaseHour` (23, local hour today's unused reserve goes to the queue), `sweepHours` (12)
- `timezone` (IANA name), `presence.idleMinutes` (30)
- `run.model` (e.g. `sonnet`), `run.timeoutMinutes` (60), `run.openDraftPr` (true)
- `guard`: `off`, `warn` or `block` when the user's own use runs past today's reserve

Confirm with the user before changing `run.researchTools`, `run.codeTools` or `run.claudePath`, since those control what unattended runs may do.

## If it isn't set up

If `backburner` isn't found, it isn't installed: point the user to `npm install -g https://github.com/MeagerPotato/backburner/archive/refs/heads/main.tar.gz`, then `backburner setup`. If status says there's no usage reading yet, run `backburner probe`. If nothing ever runs, check the background job exists (`schtasks /Query /TN Backburner` on Windows) and suggest `backburner schedule install`.
