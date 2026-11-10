/** The zone a server's clock runs in until someone sets another one with `/timezone set`. */
export const DEFAULT_TIME_ZONE = "Europe/Warsaw";

/**
 * A server's time zone. Every module that speaks of a time of day (scheduled messages and songs, `/time`,
 * dates in moderation) reads it here, so one `/timezone set` moves all of them.
 */
export interface GuildTimeZones {
  /** The server's IANA zone; the default for a server without one and outside servers (`null`). */
  of(guildId: string | null): Promise<string>;
}

/** Region names only (`Europe/Warsaw`, `UTC`). An offset like `+01:00` means the opposite sign in Postgres. */
const ZONE_NAME = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * The canonical spelling of an IANA zone (`europe/warsaw` → `Europe/Warsaw`), or null when it is not one
 * the runtime knows.
 */
export function canonicalTimeZone(input: string): string | null {
  const name = input.trim();
  if (!ZONE_NAME.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Formats `date` as `dd.MM.yyyy HH:mm` on the wall clock of `timeZone`. */
export function formatDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("pl-PL", {
    timeZone,
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")} ${part("hour")}:${part("minute")}`;
}
