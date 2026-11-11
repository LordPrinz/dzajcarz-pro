import { describe, expect, test } from "bun:test";
import { createHealth } from "./health.ts";

describe("createHealth", () => {
  test("is ok when both probes answer", async () => {
    const health = createHealth({ postgres: async () => true, redis: async () => true });
    expect(await health.check()).toEqual({ ok: true, checks: { postgres: true, redis: true } });
  });

  test("a probe that throws or hangs counts as down", async () => {
    const health = createHealth(
      {
        postgres: async () => {
          throw new Error("down");
        },
        redis: () => new Promise(() => {}),
      },
      30,
    );
    expect(await health.check()).toEqual({ ok: false, checks: { postgres: false, redis: false } });
  });

  test("concurrent checks share one run", async () => {
    let runs = 0;
    const health = createHealth({
      postgres: async () => {
        runs += 1;
        await Bun.sleep(20);
        return true;
      },
      redis: async () => true,
    });
    await Promise.all([health.check(), health.check(), health.check()]);
    expect(runs).toBe(1);
    await health.check();
    expect(runs).toBe(2);
  });
});
