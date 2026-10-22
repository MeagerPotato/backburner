import type { Config } from "./config.js";
import { DAY, HOUR, localParts, nextLocalDay, startOfLocalDay } from "./time.js";

export interface BudgetInput {
  now: number;
  config: Pick<Config, "timezone" | "reserves" | "weeklyCap" | "releaseHour" | "sweepHours">;
  /** Current weekly % used. */
  weeklyPct: number;
  /** Epoch ms of the next weekly reset. */
  resetsAt: number;
  /** Weekly % at local midnight today (or 0 if the week began today). */
  dayStartPct: number;
  /** Weekly % points the queue itself spent today. */
  queueSpentToday: number;
}

export interface Budget {
  /** Weekly % the queue may spend right now. */
  available: number;
  cap: number;
  used: number;
  /** Reserve still held for the rest of today. */
  todayHeld: number;
  todayReserve: number;
  /** What you used yourself today, outside the queue. */
  personalToday: number;
  /** Reserves held for days after today, before the reset. */
  futureHeld: number;
  sweeping: boolean;
  released: boolean;
  resetsAt: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * queue budget = cap - used - reserves for days after today - what's left of today's reserve
 *
 * Today's leftover is freed at the release hour. In the final sweep window before the
 * reset, every reserve is freed and the queue may spend up to the cap.
 */
export function computeBudget(i: BudgetInput): Budget {
  const { now, config: c } = i;
  const tz = c.timezone;
  const todayStart = startOfLocalDay(now, tz);
  const today = localParts(now, tz);
  const todayReserve = c.reserves[today.weekday] ?? 0;

  const personalToday = Math.max(0, i.weeklyPct - i.dayStartPct - i.queueSpentToday);
  const sweeping = i.resetsAt - now <= c.sweepHours * HOUR;
  const released = today.hour >= c.releaseHour;

  let todayHeld = Math.max(0, todayReserve - personalToday);
  if (released || sweeping) todayHeld = 0;

  let futureHeld = 0;
  if (!sweeping) {
    for (let d = nextLocalDay(todayStart, tz); d < i.resetsAt; d = nextLocalDay(d, tz)) {
      const weekday = localParts(d + HOUR, tz).weekday;
      // A day cut short by the reset only holds its share of the reserve.
      const share = Math.min(1, (i.resetsAt - d) / DAY);
      futureHeld += (c.reserves[weekday] ?? 0) * share;
    }
  }

  const available = Math.max(0, c.weeklyCap - i.weeklyPct - futureHeld - todayHeld);
  return {
    available: round(available),
    cap: c.weeklyCap,
    used: round(i.weeklyPct),
    todayHeld: round(todayHeld),
    todayReserve,
    personalToday: round(personalToday),
    futureHeld: round(futureHeld),
    sweeping,
    released,
    resetsAt: i.resetsAt,
  };
}
