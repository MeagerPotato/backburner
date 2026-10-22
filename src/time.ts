export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in the given IANA time zone. */
export function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: (parts.weekday ?? "Sun").slice(0, 3).toLowerCase() as Weekday,
  };
}

function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const seconds = new Date(ms).getUTCSeconds();
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, seconds);
  return asUtc - (ms - (ms % 1000));
}

/** The instant when the wall clock in `timeZone` reads the given date and time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  // A second pass settles DST edges.
  return guess - offsetAt(first, timeZone);
}

/** Local midnight at the start of the day containing `ms`. */
export function startOfLocalDay(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}

/** Local midnight of the next day. Works across DST changes. */
export function nextLocalDay(dayStart: number, timeZone: string): number {
  const p = localParts(dayStart + 36 * HOUR, timeZone);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
