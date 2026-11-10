import { describe, expect, test } from "bun:test";
import { parseTimeOfDay } from "./time.ts";

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
