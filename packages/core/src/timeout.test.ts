import { describe, expect, test } from "bun:test";
import { TimeoutError, withTimeout } from "./timeout.ts";

describe("withTimeout", () => {
  test("passes the value through when the promise settles in time", async () => {
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
  });

  test("passes the rejection through", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });

  test("rejects with a TimeoutError when the promise never settles", async () => {
    await expect(withTimeout(new Promise<never>(() => {}), 20)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});
