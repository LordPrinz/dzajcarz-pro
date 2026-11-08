import { describe, expect, test } from "bun:test";
import { createCronScheduler } from "./cron.ts";

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

  test("returns a function that stops the job", () => {
    const stop = createCronScheduler().every(NINE_AND_TWENTY_ONE, WARSAW, () => {});
    expect(() => stop()).not.toThrow();
  });
});
