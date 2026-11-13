import { describe, expect, test } from "bun:test";
import { createHealthChecker, healthHandlers } from "./health.ts";

const up = async () => true;

describe("createHealthChecker", () => {
  test("is ok when every probe is up", async () => {
    expect(await createHealthChecker({ postgres: up, redis: up })()).toEqual({
      ok: true,
      checks: { postgres: true, redis: true },
    });
  });

  test("a probe that throws counts as down", async () => {
    const check = createHealthChecker({
      postgres: async () => {
        throw new Error("connection refused");
      },
      redis: up,
    });
    expect(await check()).toEqual({ ok: false, checks: { postgres: false, redis: true } });
  });

  test("a probe that hangs counts as down once its timeout passes", async () => {
    const started = performance.now();
    const check = createHealthChecker({ postgres: up, redis: () => new Promise(() => {}) }, 50);
    expect((await check()).checks).toEqual({ postgres: true, redis: false });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("concurrent checks share one run", async () => {
    let runs = 0;
    const check = createHealthChecker({
      postgres: async () => {
        runs += 1;
        await Bun.sleep(20);
        return true;
      },
    });
    await Promise.all([check(), check(), check()]);
    expect(runs).toBe(1);
    await check();
    expect(runs).toBe(2);
  });
});

describe("healthHandlers", () => {
  test("readiness is 503 with the report when a probe is down, liveness stays 200", async () => {
    const { readiness, liveness } = healthHandlers(
      createHealthChecker({ postgres: async () => false }),
    );
    const response = await readiness();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, checks: { postgres: false } });
    expect(liveness().status).toBe(200);
  });
});
