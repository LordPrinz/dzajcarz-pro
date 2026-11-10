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
