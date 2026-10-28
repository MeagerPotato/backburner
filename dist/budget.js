import { DAY, HOUR, localParts, nextLocalDay, startOfLocalDay } from "./time.js";
const round = (n) => Math.round(n * 10) / 10;
/**
 * queue budget = cap - used - reserves for days after today - what's left of today's reserve
 *
 * Today's leftover is freed at the release hour. In the final sweep window before the
 * reset, every reserve is freed and the queue may spend up to the cap.
 */
export function computeBudget(i) {
    const { now, config: c } = i;
    const tz = c.timezone;
    const todayStart = startOfLocalDay(now, tz);
    const today = localParts(now, tz);
    const todayReserve = c.reserves[today.weekday] ?? 0;
    const personalToday = Math.max(0, i.weeklyPct - i.dayStartPct - i.queueSpentToday);
    const sweeping = i.resetsAt - now <= c.sweepHours * HOUR;
    const released = today.hour >= c.releaseHour;
    let todayHeld = Math.max(0, todayReserve - personalToday);
    if (released || sweeping)
        todayHeld = 0;
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
