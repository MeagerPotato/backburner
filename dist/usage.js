import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { DAY, HOUR, startOfLocalDay } from "./time.js";
const KEEP_MS = 14 * DAY;
export function loadSnapshots() {
    return readJson(paths.usage(), []);
}
export function recordSnapshot(s) {
    if (!s.weekly && !s.fiveHour)
        return;
    const all = loadSnapshots().filter((x) => x.at > s.at - KEEP_MS);
    const last = all.at(-1);
    // Status lines redraw constantly. Skip readings that add nothing new.
    if (last &&
        s.at - last.at < 5 * 60_000 &&
        last.weekly?.pct === s.weekly?.pct &&
        last.fiveHour?.pct === s.fiveHour?.pct &&
        last.weekly?.resetsAt === s.weekly?.resetsAt) {
        return;
    }
    all.push(s);
    all.sort((a, b) => a.at - b.at);
    writeJson(paths.usage(), all);
}
/** Newest reading that has each window. */
export function latest(snaps) {
    let weekly;
    let fiveHour;
    for (let i = snaps.length - 1; i >= 0 && (!weekly || !fiveHour); i--) {
        const s = snaps[i];
        if (!weekly && s.weekly)
            weekly = { ...s.weekly, at: s.at };
        if (!fiveHour && s.fiveHour)
            fiveHour = { ...s.fiveHour, at: s.at };
    }
    return { weekly, fiveHour };
}
/** Two readings belong to the same weekly window if their reset times are within an hour. */
export function sameWeek(a, b) {
    return Math.abs(a.resetsAt - b.resetsAt) < HOUR;
}
/**
 * Weekly % at the start of today (local midnight), or at the start of the week if
 * it began today. Uses the last reading before midnight; falls back to `current`
 * (meaning "assume you haven't used anything yet today", which keeps your full reserve).
 */
export function weeklyAtDayStart(snaps, now, timeZone, current) {
    const dayStart = startOfLocalDay(now, timeZone);
    let before;
    let firstToday;
    for (const s of snaps) {
        if (!s.weekly || !sameWeek(s.weekly, current))
            continue;
        if (s.at <= dayStart)
            before = s;
        else if (!firstToday && s.at <= now)
            firstToday = s;
    }
    if (before?.weekly)
        return before.weekly.pct;
    const weekStart = current.resetsAt - 7 * DAY;
    if (weekStart >= dayStart && weekStart <= now)
        return 0;
    if (firstToday?.weekly)
        return firstToday.weekly.pct;
    return current.pct;
}
// ---------- parsing ----------
const toMs = (epoch) => {
    if (typeof epoch !== "number" || !Number.isFinite(epoch))
        return undefined;
    return epoch < 1e12 ? epoch * 1000 : epoch;
};
function windowFromStatusline(w) {
    if (!w || typeof w !== "object")
        return undefined;
    const { used_percentage, resets_at } = w;
    const resetsAt = toMs(resets_at);
    if (typeof used_percentage !== "number" || resetsAt === undefined)
        return undefined;
    return { pct: used_percentage, resetsAt };
}
/** Reads `rate_limits` from the JSON Claude Code sends to status line commands. */
export function parseStatusline(input, at = Date.now()) {
    const rl = input?.rate_limits;
    if (!rl)
        return undefined;
    const snap = {
        at,
        source: "statusline",
        weekly: windowFromStatusline(rl.seven_day),
        fiveHour: windowFromStatusline(rl.five_hour),
    };
    return snap.weekly || snap.fiveHour ? snap : undefined;
}
function windowFromStream(w) {
    if (!w || typeof w !== "object")
        return undefined;
    const { utilization, resetsAt } = w;
    const ms = toMs(resetsAt);
    if (typeof utilization !== "number" || ms === undefined)
        return undefined;
    // The stream reports 0..1; the status line reports 0..100.
    return { pct: utilization <= 1 ? utilization * 100 : utilization, resetsAt: ms };
}
/** Reads a `rate_limit_event` line from `claude -p --output-format stream-json`. */
export function parseStreamEvent(event, at = Date.now()) {
    const e = event;
    if (e?.type !== "rate_limit_event")
        return undefined;
    const w = e.rate_limit_info?.unifiedWindows;
    if (!w)
        return undefined;
    const snap = {
        at,
        source: "stream",
        weekly: windowFromStream(w.seven_day),
        fiveHour: windowFromStream(w.five_hour),
    };
    return snap.weekly || snap.fiveHour ? snap : undefined;
}
/** True when a stream event says requests are being refused because of a limit. */
export function isRejection(event) {
    const e = event;
    return e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected";
}
