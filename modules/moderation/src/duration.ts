/** Discord refuses a timeout longer than 28 days. */
export const MAX_TIMEOUT_MS = 28 * 24 * 3_600_000;

const UNITS = {
  s: { ms: 1000, label: "s" },
  m: { ms: 60_000, label: "min" },
  h: { ms: 3_600_000, label: "h" },
  d: { ms: 24 * 3_600_000, label: "d" },
} as const;

const PATTERN = /^(\d+)\s*([smhd])$/i;

/**
 * A timeout length typed as `30s`, `10m`, `2h` or `1d`: the length in milliseconds and the same length as
 * the replies show it (`10 min`). Null for anything else, zero, or more than 28 days.
 */
export function parseDuration(input: string): { ms: number; label: string } | null {
  const match = PATTERN.exec(input.trim());
  if (!match) return null;
  const [, digits = "", unitKey = ""] = match;
  const unit = UNITS[unitKey.toLowerCase() as keyof typeof UNITS];
  const amount = Number(digits);
  const ms = amount * unit.ms;
  // A huge number of digits turns into Infinity or loses precision; both fail the upper bound.
  if (amount <= 0 || !(ms <= MAX_TIMEOUT_MS)) return null;
  return { ms, label: `${amount} ${unit.label}` };
}
