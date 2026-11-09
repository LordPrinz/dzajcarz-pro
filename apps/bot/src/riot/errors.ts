import { MAX_RETRY_AFTER_MS, RiotLookupError } from "@dzajcarz/module-riot";

/** Both clients stop waiting for Riot after this long. */
export const TIMEOUT_MS = 8000;

/** A wait Riot sent: zero, negative or not a number counts as absent, and a huge one is capped. */
function sanitizeRetryAfter(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(Math.ceil(ms), MAX_RETRY_AFTER_MS);
}

/** Riot's status codes as the module understands them. */
export function lookupErrorFromStatus(status: number, retryAfterMs?: number): RiotLookupError {
  if (status === 404) return new RiotLookupError("not-found");
  if (status === 401 || status === 403) return new RiotLookupError("forbidden");
  if (status === 429) return new RiotLookupError("rate-limited", sanitizeRetryAfter(retryAfterMs));
  return new RiotLookupError("unavailable");
}

/** `Retry-After` is a number of seconds; an empty or odd value counts as absent. */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  return sanitizeRetryAfter(Number(header) * 1000);
}
