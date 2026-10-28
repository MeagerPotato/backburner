import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'backburner',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
    title: '',
    isFocused: false,
  },
} as const

const reset = Date.parse('2026-10-26T07:00:00Z')

function summary(over: Record<string, unknown> = {}) {
  return {
    weekly: { pct: 58, resetsAt: reset, at: 0 },
    fiveHour: { pct: 10, resetsAt: reset },
    budget: { available: 18, cap: 95, used: 58, todayReserve: 5, todayHeld: 4, personalToday: 1, futureHeld: 15, sweeping: false, released: false },
    overToday: 0,
    eatingFuture: 0,
    presence: { effective: 'away', mode: 'auto', reason: 'idle' },
    queued: 3,
    queuedPct: 7,
    next: { run: true, taskId: 'abc', title: 'Summarize papers', why: '18% available' },
    guard: 'warn',
    timezone: 'America/Los_Angeles',
    ...over,
  }
}

/** Stands in for the engine beneath the mod: a home folder, a config, and the CLI. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], answer: () => unknown, calls: string[][] = []) {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/allen' : undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ integration: { node: '/usr/bin/node', cli: '/bb/cli.js' } }) }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [{ kind: 'seven_day', percentUsed: 58, resetsAt: new Date(reset).toISOString() }] } }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const verb = e.argv[2]
    const stdout = verb === 'ingest' ? JSON.stringify(answer()) : verb === 'list' ? '[]' : 'ok'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/allen/site' }))
  return calls
}

test('the band shows the budget and the presence toggle on every surface', async ($, on) => {
  engine(on, () => summary())
  await $.session.start({ cwd: '/home/allen/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'auto', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /queue can spend 18%/ }))?.text).toMatch(/3 queued/)
    expect(await ui.find({ key: 'mode-away' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /later days/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('pressing Away tells the CLI', async ($, on) => {
  const calls = engine(on, () => summary())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'auto', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'mode-away' })
  expect(calls.some(c => c[2] === 'away')).toBe(true)
  await ui.unmount()
})

test('/queue-code queues a coding task in the session folder', async ($, on) => {
  const calls = engine(on, () => summary())
  await $.session.start({ cwd: '/home/allen/site', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'queue-code', args: 'add tests for the signup form' })
  expect(out.text).toBe('ok')
  const add = calls.find(c => c[2] === 'add')
  expect(add).toEqual(['/usr/bin/node', '/bb/cli.js', 'add', 'add tests for the signup form', '--dir', '/home/allen/site', '--code'])
})

test('the band warns when your own use eats into later days', async ($, on) => {
  engine(on, () =>
    summary({
      overToday: 4,
      eatingFuture: 3,
      budget: { available: 0, cap: 95, used: 92, todayReserve: 5, todayHeld: 0, personalToday: 9, futureHeld: 6, sweeping: false, released: false },
    }),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'auto', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /later days/ }))?.text).toMatch(/used 9% today against a 5% reserve, so 3%/)
  await ui.unmount()
})

test('the band explains missing setup', async ($, on) => {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/allen' : undefined }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'auto', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Backburner:/ }))?.text).toMatch(/backburner init/)
  await ui.unmount()
})
