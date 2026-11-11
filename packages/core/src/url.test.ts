import { describe, expect, test } from "bun:test";
import { credentialsIntact } from "./url.ts";

describe("credentialsIntact", () => {
  test("ignores URLs without credentials", () => {
    expect(credentialsIntact("redis://redis:6379/0")).toBe(true);
  });

  test("is false when a slash in the password cuts the host part short", () => {
    expect(credentialsIntact("postgres://u:12/x@db/db")).toBe(false);
  });
});
