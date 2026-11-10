import { describe, expect, test } from "bun:test";
import { MAX_TIMEOUT_MS, parseDuration } from "./duration.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseDuration", () => {
  test("reads seconds, minutes, hours and days with a readable label", () => {
    expect(parseDuration("30s")).toEqual({ ms: 30 * SECOND, label: "30 s" });
    expect(parseDuration("10m")).toEqual({ ms: 10 * MINUTE, label: "10 min" });
    expect(parseDuration("2h")).toEqual({ ms: 2 * HOUR, label: "2 h" });
    expect(parseDuration("1d")).toEqual({ ms: DAY, label: "1 d" });
  });

  test("28 days is the longest timeout Discord allows and is accepted", () => {
    expect(parseDuration("28d")).toEqual({ ms: 28 * DAY, label: "28 d" });
    expect(MAX_TIMEOUT_MS).toBe(28 * DAY);
    expect(parseDuration("672h")?.ms).toBe(28 * DAY);
  });

  test("ignores case, surrounding spaces and a space before the unit", () => {
    expect(parseDuration(" 2H ")?.ms).toBe(2 * HOUR);
    expect(parseDuration("15 m")?.ms).toBe(15 * MINUTE);
  });

  test("rejects zero, more than 28 days, missing or unknown units, signs and fractions", () => {
    for (const input of [
      "0s",
      "0d",
      "29d",
      "673h",
      "40321m",
      "10",
      "1w",
      "-1m",
      "+1m",
      "1.5h",
      "",
      "h",
      "1h30m",
      "99999999999999999999d",
    ]) {
      expect(parseDuration(input)).toBeNull();
    }
  });
});
