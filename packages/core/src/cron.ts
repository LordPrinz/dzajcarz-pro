/** Runs something on a cron schedule. A port, so tests fire the schedule by hand instead of waiting. */
export interface CronScheduler {
  /**
   * Calls `task` whenever `expression` (five fields, `minute hour day month weekday`) matches in the
   * IANA time zone `timeZone`. Throws on an expression or zone it cannot read. Returns a function that
   * stops the schedule.
   */
  every(expression: string, timeZone: string, task: () => void | Promise<void>): () => void;
}

/** The real thing: `Bun.cron`, which follows the zone's daylight saving changes. */
export function createCronScheduler(): CronScheduler {
  return {
    every(expression, timeZone, task) {
      // parse() validates both arguments now; the job itself would only fail when it first fires.
      if (Bun.cron.parse(expression, Date.now(), { tz: timeZone }) === null) {
        throw new Error(`The cron expression "${expression}" never fires`);
      }
      const job = Bun.cron(expression, task, { tz: timeZone });
      return () => {
        job.stop();
      };
    },
  };
}
