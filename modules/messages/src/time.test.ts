import { describe, expect, test } from "bun:test";
import { localMinute, parseTimeOfDay } from "./time.ts";

const ZONE = "Europe/Warsaw";

describe("parseTimeOfDay", () => {
  test("accepts H:MM and HH:MM and stores HH:MM", () => {
    expect(parseTimeOfDay("7:05")).toBe("07:05");
    expect(parseTimeOfDay("07:05")).toBe("07:05");
    expect(parseTimeOfDay("19:00")).toBe("19:00");
    expect(parseTimeOfDay("0:00")).toBe("00:00");
    expect(parseTimeOfDay("23:59")).toBe("23:59");
    expect(parseTimeOfDay(" 9:30 ")).toBe("09:30");
  });

  test("rejects times that do not exist and other formats", () => {
    for (const input of [
      "24:00",
      "12:60",
      "1900",
      "19.00",
      "",
      "7:5",
      "007:00",
      "-1:00",
      "ab:cd",
    ]) {
      expect(parseTimeOfDay(input)).toBeNull();
    }
  });
});

describe("localMinute", () => {
  test("summer time is UTC+2 and winter time UTC+1", () => {
    expect(localMinute(new Date("2026-07-01T17:00:00Z"), ZONE)).toEqual({
      date: "2026-07-01",
      time: "19:00",
    });
    expect(localMinute(new Date("2026-01-01T18:00:00Z"), ZONE)).toEqual({
      date: "2026-01-01",
      time: "19:00",
    });
  });

  test("the date is the Warsaw date, past midnight there while UTC is still on the day before", () => {
    expect(localMinute(new Date("2026-12-31T23:30:00Z"), ZONE)).toEqual({
      date: "2027-01-01",
      time: "00:30",
    });
  });

  test("midnight reads 00:00, not 24:00", () => {
    expect(localMinute(new Date("2026-01-01T23:00:00Z"), ZONE).time).toBe("00:00");
  });

  test("the March change skips 02:00-02:59", () => {
    expect(localMinute(new Date("2026-03-29T00:59:00Z"), ZONE).time).toBe("01:59");
    expect(localMinute(new Date("2026-03-29T01:00:00Z"), ZONE).time).toBe("03:00");
  });

  test("the October change repeats 02:xx on the same date", () => {
    const first = localMinute(new Date("2026-10-25T00:30:00Z"), ZONE);
    const second = localMinute(new Date("2026-10-25T01:30:00Z"), ZONE);
    expect(first).toEqual({ date: "2026-10-25", time: "02:30" });
    expect(second).toEqual(first);
  });
});
