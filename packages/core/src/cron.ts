/** Runs something on a cron schedule. A port, so tests fire the schedule by hand instead of waiting. */
export interface CronScheduler {
  /**
   * Calls `task` whenever `expression` (five fields, `minute hour day month weekday`) matches in the
   * IANA time zone `timeZone`. Throws on an expression or zone it cannot read. Returns a function that
   * stops the schedule.
   */
  every(expression: string, timeZone: string, task: () => void | Promise<void>): () => void;
}

/** How a job gets started; `Bun.cron` outside tests. */
export type StartCronJob = (
  expression: string,
  task: () => void | Promise<void>,
  options: { tz: string },
) => { stop(): void };

/** The real thing: `Bun.cron`, which follows the zone's daylight saving changes. */
export function createCronScheduler(start: StartCronJob = Bun.cron): CronScheduler {
  return {
    every(expression, timeZone, task) {
      // parse() validates both arguments now; the job itself would only fail when it first fires.
      if (Bun.cron.parse(expression, Date.now(), { tz: timeZone }) === null) {
        throw new Error(`The cron expression "${expression}" never fires`);
      }
      const job = start(expression, task, { tz: timeZone });
      return () => {
        job.stop();
      };
    },
  };
}

/**
 * Whether a five-field cron `expression` fires at the minute starting at `minute` (seconds dropped) on the
 * wall clock of `timeZone`. Lets one ticking job serve servers in different zones.
 */
export function firesAt(expression: string, minute: Date, timeZone: string): boolean {
  const start = Math.floor(minute.getTime() / 60_000) * 60_000;
  const next = Bun.cron.parse(expression, start - 1, { tz: timeZone });
  return next !== null && next.getTime() === start;
}
