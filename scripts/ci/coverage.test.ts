import { describe, expect, test } from "bun:test";
import { belowMinimum, sumLcov } from "./coverage.ts";

const REPORT = [
  "TN:",
  "SF:a.ts",
  "FNF:10",
  "FNH:9",
  "LF:100",
  "LH:99",
  "end_of_record",
  "SF:b.ts",
  "FNF:10",
  "FNH:5",
  "LF:100",
  "LH:50",
  "end_of_record",
].join("\n");

describe("coverage totals", () => {
  test("sums every file of the report", () => {
    expect(sumLcov(REPORT)).toEqual({
      functions: { found: 20, hit: 14 },
      lines: { found: 200, hit: 149 },
    });
  });

  test("a weak file does not fail the run while the total is above the minimum", () => {
    expect(belowMinimum(sumLcov(REPORT), { functions: 0.7, lines: 0.74 })).toEqual([]);
  });

  test("names each metric under its minimum", () => {
    expect(belowMinimum(sumLcov(REPORT), { functions: 0.8, lines: 0.8 })).toEqual([
      "functions: 70.00% is below the minimum 80%",
      "lines: 74.50% is below the minimum 80%",
    ]);
  });
});
