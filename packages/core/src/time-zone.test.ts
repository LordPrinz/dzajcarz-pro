import { describe, expect, test } from "bun:test";
import { canonicalTimeZone, firesAt, formatDateTime } from "./index.ts";

describe("canonicalTimeZone", () => {
  test("accepts IANA names in any case and returns their canonical spelling", () => {
    expect(canonicalTimeZone("Europe/Warsaw")).toBe("Europe/Warsaw");
    expect(canonicalTimeZone(" europe/london ")).toBe("Europe/London");
    expect(canonicalTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
    expect(canonicalTimeZone("UTC")).toBe("UTC");
  });

  test("refuses offsets, abbreviations and unknown names", () => {
    for (const input of ["+01:00", "CET", "GMT+1", "Mars/Olympus", "", "Europe/Warsaw; DROP"]) {
      expect(canonicalTimeZone(input)).toBeNull();
    }
  });
});

describe("firesAt", () => {
  const NINE = "0 9 * * *";

  test("9:00 in Warsaw is 7:00 UTC in summer and 8:00 UTC in winter", () => {
    expect(firesAt(NINE, new Date("2026-07-01T07:00:00Z"), "Europe/Warsaw")).toBe(true);
    expect(firesAt(NINE, new Date("2026-07-01T08:00:00Z"), "Europe/Warsaw")).toBe(false);
    expect(firesAt(NINE, new Date("2026-01-15T08:00:00Z"), "Europe/Warsaw")).toBe(true);
  });

  test("the same instant is 9:00 in one zone and not in another", () => {
    const instant = new Date("2026-07-01T08:00:00Z");
    expect(firesAt(NINE, instant, "Europe/London")).toBe(true);
    expect(firesAt(NINE, instant, "Europe/Warsaw")).toBe(false);
  });

  test("seconds inside the minute do not matter", () => {
    expect(firesAt(NINE, new Date("2026-07-01T07:00:42Z"), "Europe/Warsaw")).toBe(true);
  });
});

test("formatDateTime shows the wall clock of the zone", () => {
  const instant = new Date("2026-07-01T22:30:00Z");
  expect(formatDateTime(instant, "Europe/Warsaw")).toBe("02.07.2026 00:30");
  expect(formatDateTime(instant, "America/New_York")).toBe("01.07.2026 18:30");
});
