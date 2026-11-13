import { expect, test } from "bun:test";
import { formatBytes } from "./format.ts";

test("sizes read as kilobytes or megabytes", () => {
  expect(formatBytes(0)).toBe("1 KB");
  expect(formatBytes(1500)).toBe("2 KB");
  expect(formatBytes(10 * 1_048_576)).toBe("10 MB");
  expect(formatBytes(1.5 * 1_048_576)).toBe("1.5 MB");
});
