import { describe, expect, test } from "bun:test";
import { createCronScheduler, type StartCronJob, tickMinute } from "./cron.ts";

const WARSAW = "Europe/Warsaw";
const NINE_AND_TWENTY_ONE = "0 9,21 * * *";

/** The instants (UTC) at which the schedule fires, `count` of them from `from`. */
function firings(from: string, count: number): string[] {
  const fires: string[] = [];
  let cursor = Date.parse(from);
  for (let i = 0; i < count; i++) {
    const next = Bun.cron.parse(NINE_AND_TWENTY_ONE, cursor, { tz: WARSAW });
    if (!next) break;
    fires.push(next.toISOString());
    cursor = next.getTime();
  }
  return fires;
}

describe("the schedule in Europe/Warsaw", () => {
  test("fires at 9:00 and 21:00 local time in winter (UTC+1)", () => {
    expect(firings("2026-01-10T00:00:00Z", 3)).toEqual([
      "2026-01-10T08:00:00.000Z",
      "2026-01-10T20:00:00.000Z",
      "2026-01-11T08:00:00.000Z",
    ]);
  });

  test("fires at 9:00 and 21:00 local time in summer (UTC+2)", () => {
    expect(firings("2026-07-10T00:00:00Z", 2)).toEqual([
      "2026-07-10T07:00:00.000Z",
      "2026-07-10T19:00:00.000Z",
    ]);
  });

  test("keeps the local time across the spring change (29 March 2026)", () => {
    expect(firings("2026-03-28T10:00:00Z", 3)).toEqual([
      "2026-03-28T20:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      "2026-03-29T19:00:00.000Z",
    ]);
  });

  test("keeps the local time across the autumn change (25 October 2026)", () => {
    expect(firings("2026-10-24T10:00:00Z", 3)).toEqual([
      "2026-10-24T19:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T20:00:00.000Z",
    ]);
  });
});

describe("createCronScheduler", () => {
  test("rejects a bad expression and an unknown zone before anything is scheduled", () => {
    const cron = createCronScheduler();
    expect(() => cron.every("not a cron", WARSAW, () => {})).toThrow();
    expect(() => cron.every(NINE_AND_TWENTY_ONE, "Mars/Olympus", () => {})).toThrow();
  });

  function recordingStart() {
    const jobs: {
      expression: string;
      tz: string;
      task: () => void | Promise<void>;
      stops: number;
    }[] = [];
    const start: StartCronJob = (expression, task, { tz }) => {
      const job = { expression, tz, task, stops: 0 };
      jobs.push(job);
      return { stop: () => void job.stops++ };
    };
    return { jobs, start };
  }

  test("starts one job with the expression, the zone and the task", () => {
    const { jobs, start } = recordingStart();
    let ran = 0;
    createCronScheduler(start).every(NINE_AND_TWENTY_ONE, WARSAW, () => void ran++);
    expect(jobs.map(({ expression, tz }) => ({ expression, tz }))).toEqual([
      { expression: NINE_AND_TWENTY_ONE, tz: WARSAW },
    ]);
    jobs[0]?.task();
    expect(ran).toBe(1);
  });

  test("the returned function stops that job", () => {
    const { jobs, start } = recordingStart();
    const stop = createCronScheduler(start).every(NINE_AND_TWENTY_ONE, WARSAW, () => {});
    expect(jobs[0]?.stops).toBe(0);
    stop();
    expect(jobs[0]?.stops).toBe(1);
  });

  test("a rejected expression starts no job", () => {
    const { jobs, start } = recordingStart();
    expect(() => createCronScheduler(start).every("not a cron", WARSAW, () => {})).toThrow();
    expect(jobs).toEqual([]);
  });

  test("works with the real Bun.cron", () => {
    const stop = createCronScheduler().every(NINE_AND_TWENTY_ONE, WARSAW, () => {});
    expect(() => stop()).not.toThrow();
  });
});

describe("tickMinute", () => {
  const minuteOf = (iso: string) => tickMinute(new Date(iso)).toISOString();

  test("an on-time or late tick keeps its own minute", () => {
    expect(minuteOf("2026-01-01T09:00:00.000Z")).toBe("2026-01-01T09:00:00.000Z");
    expect(minuteOf("2026-01-01T09:00:54.999Z")).toBe("2026-01-01T09:00:00.000Z");
  });

  test("a tick up to 5 s early belongs to the coming minute", () => {
    expect(minuteOf("2026-01-01T09:00:55.000Z")).toBe("2026-01-01T09:01:00.000Z");
    expect(minuteOf("2026-01-01T09:00:59.999Z")).toBe("2026-01-01T09:01:00.000Z");
  });
});
