/** Bulk delete works up to 14 days; stay a minute inside so a message does not age out in flight. */
export const BULK_MAX_AGE_MS = 14 * 24 * 3_600_000 - 60_000;
