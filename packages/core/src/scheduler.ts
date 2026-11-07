/** Runs something once, later. A port, so tests drive time by hand instead of waiting. */
export interface Scheduler {
  /** Runs `task` after `delayMs`. Returns a function that cancels it (a no-op once it ran). */
  after(delayMs: number, task: () => void): () => void;
}

/** The real thing: `setTimeout`. */
export function createScheduler(): Scheduler {
  return {
    after(delayMs, task) {
      const handle = setTimeout(task, delayMs);
      return () => clearTimeout(handle);
    },
  };
}
