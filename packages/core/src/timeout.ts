/** Longest a Redis read or counter on the interaction path may take; Discord gives an interaction 3 s. */
export const STORE_TIMEOUT_MS = 500;

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/**
 * Rejects with a TimeoutError when `promise` has not settled within `ms`. The work is not cancelled, only
 * abandoned: a stalled Redis must cost the caller its fallback path, not the whole interaction.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number = STORE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
