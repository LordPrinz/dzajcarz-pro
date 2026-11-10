import { describe, expect, test } from "bun:test";
import { skippedSuitesWarning } from "./check-test-env.ts";

describe("skippedSuitesWarning", () => {
  test("is empty when both variables are set", () => {
    expect(
      skippedSuitesWarning({ TEST_DATABASE_URL: "postgres://x", TEST_REDIS_URL: "redis://x" }),
    ).toEqual([]);
  });

  test("names the database suites when TEST_DATABASE_URL is missing", () => {
    const lines = skippedSuitesWarning({ TEST_REDIS_URL: "redis://x" }).join("\n");
    expect(lines).toContain("database");
    expect(lines).not.toContain("Redis (");
    expect(lines).toContain(".env.example");
  });

  test("names the Redis suites when TEST_REDIS_URL is missing", () => {
    const lines = skippedSuitesWarning({ TEST_DATABASE_URL: "postgres://x" }).join("\n");
    expect(lines).toContain("Redis (TEST_REDIS_URL)");
    expect(lines).not.toContain("database (");
  });

  test("treats empty values as missing", () => {
    const lines = skippedSuitesWarning({ TEST_DATABASE_URL: "", TEST_REDIS_URL: "" }).join("\n");
    expect(lines).toContain("database (");
    expect(lines).toContain("Redis (");
  });
});
