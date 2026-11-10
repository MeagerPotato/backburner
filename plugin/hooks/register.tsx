import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BackburnerSetup, BackburnerSummary, BackburnerTask } from '../types'

// The mod is a thin front end: every number comes from the `backburner` CLI,
// which owns the budget math, the queue and the presence file.

const PANE = 'backburner-queue'
const summaryAtom = atom({ plugin: 'backburner', key: 'summary' } as const, null)
const setupAtom = atom({ plugin: 'backburner', key: 'setup' } as const, null)
const tasksAtom = atom({ plugin: 'backburner', key: 'tasks' } as const, [])
const warnedDay = atom({ plugin: 'backburner', key: 'warnedDay' } as const, '')

type $ = EngineInterface
type Mode = 'active' | 'away' | 'auto'

async function backburnerHome($: $): Promise<string | undefined> {
  const override = await $.env.get('BACKBURNER_HOME')
  if (override) return override
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.backburner` : undefined
}

async function loadSetup($: $): Promise<BackburnerSetup> {
  const home = await backburnerHome($)
  if (!home) return { missing: 'no home folder found' }
  try {
    const config = JSON.parse(await $.fs.read(`${home}/config.json`)) as {
      integration?: { node?: string; cli?: string }
    }
    const node = config.integration?.node
    const cli = config.integration?.cli
    if (node && cli) return { node, cli }
    return { missing: 'run `backburner init` once in a terminal' }
  } catch {
    return { missing: 'install Backburner, then run `backburner init`' }
  }
}

async function cli($: $, args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> {
  let setup = await read($, setupAtom)
  if (!setup || 'missing' in setup) {
    setup = await loadSetup($)
    await update($, setupAtom, () => setup)
  }
  if ('missing' in setup) return { ok: false, out: `Backburner isn't set up yet: ${setup.missing}.` }
  try {
    const r = await $.process.run([setup.node, setup.cli, ...args], { stdin, timeoutMs: 30_000 })
    return { ok: r.exitCode === 0, out: (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim() }
  } catch (err) {
    return { ok: false, out: `Couldn't run Backburner: ${String(err)}` }
  }
}

/** Hand the CLI the usage numbers this session sees, and keep the summary it answers with. */
async function refresh($: $): Promise<void> {
  const usage = await $.session.usage().catch(() => undefined)
  const limits: Record<string, { used_percentage: number; resets_at: number }> = {}
  for (const r of usage?.rateLimits ?? []) {
    if ((r.kind === 'five_hour' || r.kind === 'seven_day') && r.resetsAt) {
      limits[r.kind] = { used_percentage: r.percentUsed, resets_at: Math.floor(Date.parse(r.resetsAt) / 1000) }
    }
  }
  const { ok, out } = await cli($, ['ingest'], JSON.stringify({ rate_limits: limits }))
  if (!ok) return
  try {
    const summary = JSON.parse(out) as BackburnerSummary
    await update($, summaryAtom, () => summary)
  } catch {
    // A garbled answer leaves the last good summary on screen.
  }
}

async function loadTasks($: $): Promise<void> {
  const { ok, out } = await cli($, ['list', '--json'])
  if (!ok) return
  try {
    const tasks = JSON.parse(out) as BackburnerTask[]
    await update($, tasksAtom, () => tasks)
  } catch {
    // Keep the last list.
  }
}

async function setMode($: $, mode: Mode): Promise<string> {
  const { out } = await cli($, [mode])
  await refresh($)
  return out
}

// Backburner's own tools (add_task, update_task, get_status...), registered from the
// CLI's list so the CLI stays the one place they're defined. The model sees them as
// mcp__backburner__<name>; each call goes to `backburner call <name>`.
type ToolDef = { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } & Record<string, unknown> }
const toolArgs = new Map<string, string[]>()

async function registerTools($: $): Promise<void> {
  const { ok, out } = await cli($, ['tools'])
  if (!ok) return
  let tools: ToolDef[]
  try {
    tools = (JSON.parse(out) as { tools: ToolDef[] }).tools
  } catch {
    return
  }
  for (const t of tools) {
    await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema })
    toolArgs.set(`mcp__${$.plugin.name}__${t.name}`, Object.keys(t.inputSchema.properties ?? {}))
  }
}

/** Run work in the background; a failure there must never surface as an unhandled rejection. */
function bg(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

function when(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function today(timeZone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone })
}

function headline(s: BackburnerSummary): string {
  if (!s.budget || !s.weekly) return `waiting for a usage reading · ${s.queued} queued`
  const sweep = s.budget.sweeping ? ' · final sweep' : ''
  return `week ${Math.round(s.budget.used)}% · queue can spend ${s.budget.available}% · ${s.queued} queued · resets ${when(s.weekly.resetsAt, s.timezone)}${sweep}`
}

function paceWarning(s: BackburnerSummary): string | undefined {
  if (!s.budget || s.overToday <= 0 || s.eatingFuture <= 0) return undefined
  return `You've used ${s.budget.personalToday}% today against a ${s.budget.todayReserve}% reserve, so ${s.eatingFuture}% is coming out of later days.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'queue', description: 'Queue a research task for Backburner', argumentHint: '<what Claude should do>' })
    await $.command.register({ name: 'queue-code', description: 'Queue a coding task in this repo for Backburner', argumentHint: '<what to change>' })
    await $.command.register({ name: 'away', description: 'Tell Backburner you are away, so the queue can run' })
    await $.command.register({ name: 'active', description: 'Tell Backburner you are here, so the queue holds back' })
    await $.command.register({ name: 'auto', description: 'Let Backburner decide from your idle time' })
    await $.command.register({ name: 'backburner', description: 'Show the Backburner budget and queue' })
    await registerTools($).catch(() => undefined)
    bg(refresh($))
    $.clock.every(60_000, () => bg(refresh($)))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    bg(refresh($))
    return done
  })

  // Tells Backburner you're active, and runs the pace guard.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    bg(cli($, ['hook', 'prompt'], '{}'))
    const s = await read($, summaryAtom)
    const warning = s && s.guard !== 'off' ? paceWarning(s) : undefined
    if (s && warning) {
      const day = today(s.timezone)
      if ((await read($, warnedDay)) !== day) {
        await update($, warnedDay, () => day)
        if (s.guard === 'block') return { drop: `Backburner: ${warning} Send your prompt again to go ahead.` }
        $.ui.toast(`Backburner: ${warning}`)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const keys = toolArgs.get(e.tool)
    if (!keys) return next(e)
    const input = e as unknown as Record<string, unknown>
    const args: Record<string, unknown> = {}
    for (const k of keys) if (input[k] !== undefined) args[k] = input[k]
    const name = e.tool.slice(`mcp__${$.plugin.name}__`.length)
    const { ok, out } = await cli($, ['call', name], JSON.stringify(args))
    let answer = out
    let isError = !ok
    try {
      const r = JSON.parse(out) as { content?: { text?: string }[]; isError?: boolean }
      answer = (r.content ?? []).map(c => c.text ?? '').join('\n')
      isError = isError || r.isError === true
    } catch {
      // Not JSON: pass the CLI's own words through.
    }
    bg(refresh($))
    return { result: isError ? `Error: ${answer}` : answer }
  }).catch(($, e, next) => (toolArgs.has(e.tool) ? { deny: 'Backburner could not run that tool.' } : next(e)))

  on('command.run', { command: ['queue', 'queue-code'] }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: `Usage: /${e.command} <what Claude should do>` }
    const args = ['add', text, '--dir', await $.session.cwd()]
    if (e.command === 'queue-code') args.push('--code')
    const { out } = await cli($, args)
    bg(refresh($))
    return { text: out }
  })

  on('command.run', { command: ['away', 'active', 'auto'] }, async ($, e) => ({
    text: await setMode($, e.command as Mode),
  }))

  on('command.run', { command: 'backburner' }, async $ => {
    await Promise.all([refresh($), loadTasks($)])
    await $.ui.open({ id: PANE, title: 'Backburner' })
    return { text: 'Backburner pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const setup = await read($, setupAtom)
    const s = await read($, summaryAtom)

    if (setup && 'missing' in setup) {
      return (
        <Box>
          <Text dimColor wrap="truncate">Backburner: {setup.missing}</Text>
        </Box>
      )
    }
    if (!s) return next(e)

    const mode = s.presence.mode
    const warning = paceWarning(s)
    const modeButton = (m: Mode, label: string) => (
      <Button key={`mode-${m}`} label={label} variant={mode === m ? 'primary' : 'secondary'} onPress={() => bg(setMode($, m))} />
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold>Backburner</Text>
          {modeButton('active', 'Active')}
          {modeButton('away', 'Away')}
          {modeButton('auto', mode === 'auto' ? `Auto: ${s.presence.effective}` : 'Auto')}
          <Text dimColor wrap="truncate">{headline(s)}</Text>
        </Box>
        {warning && <Text color="warning" wrap="truncate">{warning}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, summaryAtom)
    const tasks = await read($, tasksAtom)
    const b = s?.budget
    return (
      <Box flexDirection="column" gap={1}>
        {s && b ? (
          <Box flexDirection="column">
            <Text>Weekly usage {b.used}% of a {b.cap}% cap{s.weekly ? `, resets ${when(s.weekly.resetsAt, s.timezone)}` : ''}</Text>
            <Text>Today: {b.personalToday}% used of a {b.todayReserve}% reserve, {b.todayHeld}% still held</Text>
            <Text>Later days: {b.futureHeld}% held{b.sweeping ? ' (final sweep, all freed)' : ''}</Text>
            <Text bold>Queue can spend {b.available}% now</Text>
            <Text dimColor>Next: {s.next.run ? `run "${s.next.title}"` : `wait (${s.next.why})`}</Text>
          </Box>
        ) : (
          <Text dimColor>No usage reading yet.</Text>
        )}
        <Box flexDirection="column">
          <Text bold>Queue ({tasks.length})</Text>
          {tasks.length === 0 && <Text dimColor>Empty. Add one with /queue or /queue-code.</Text>}
          {tasks.map(t => (
            <Box key={`row-${t.id}`} flexDirection="row" gap={1}>
              <Button
                key={`cancel-${t.id}`}
                label="Cancel"
                onPress={async () => {
                  await cli($, ['remove', t.id])
                  await Promise.all([loadTasks($), refresh($)])
                }}
              />
              <Text wrap="truncate">
                P{t.priority} {t.mode} ~{t.estimate.pct}%{t.deadline ? ` due ${t.deadline}` : ''} {t.title}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
