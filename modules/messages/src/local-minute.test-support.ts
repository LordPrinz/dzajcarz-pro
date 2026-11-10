/**
 * The fake store's stand-in for what Postgres does in `due()`: the wall-clock minute `now` falls on in
 * `timeZone`. Only tests use it; the real conversion and its clock-change cases are tested against Postgres
 * in packages/db/src/scheduled-messages.test.ts.
 */
export interface LocalMinute {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  /** `HH:MM` in the zone, 24-hour clock. */
  time: string;
}

/** The wall-clock minute `now` falls on in `timeZone`, with the date on that zone's side of midnight. */
export function localMinute(now: Date, timeZone: string): LocalMinute {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}
