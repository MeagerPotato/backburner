/** What `backburner ingest` and `backburner status --json` print. */
export type BackburnerSummary = {
  weekly: { pct: number; resetsAt: number; at: number } | null
  fiveHour: { pct: number; resetsAt: number } | null
  budget: {
    available: number
    cap: number
    used: number
    todayReserve: number
    todayHeld: number
    personalToday: number
    futureHeld: number
    sweeping: boolean
    released: boolean
  } | null
  overToday: number
  eatingFuture: number
  presence: { effective: 'active' | 'away'; mode: 'auto' | 'active' | 'away'; reason: string }
  queued: number
  queuedPct: number
  next: { run: boolean; taskId?: string; title?: string; why: string }
  guard: 'off' | 'warn' | 'block'
  timezone: string
}

/** One row of `backburner list --json`. */
export type BackburnerTask = {
  id: string
  title: string
  mode: 'research' | 'code'
  priority: number
  deadline?: string
  size: string
  status: string
  estimate: { pct: number; minutes: number }
}

/** Where the CLI lives, from ~/.backburner/config.json, or why it couldn't be found. */
export type BackburnerSetup = { node: string; cli: string } | { missing: string }

declare module 'claude-code' {
  interface PluginState {
    backburner: {
      summary: BackburnerSummary | null
      setup: BackburnerSetup | null
      tasks: BackburnerTask[]
      warnedDay: string
    }
  }
}
