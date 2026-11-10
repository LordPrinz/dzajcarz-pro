const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;

/** `7:05` or `07:05` → `07:05`; null for anything that is not a time of day (`24:00`, `12:60`, `1900`). */
export function parseTimeOfDay(input: string): string | null {
  const match = TIME_OF_DAY.exec(input.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

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
