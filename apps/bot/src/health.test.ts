import { afterEach, describe, expect, test } from "bun:test";
import { createJsonLogger } from "@dzajcarz/core";
import { checkHealth, type Probes, startHealthServer } from "./health.ts";
import { runHealthcheck } from "./healthcheck.ts";

const up = async () => true;
const down = async () => false;
const allUp: Probes = { gateway: up, postgres: up, redis: up };
const logger = createJsonLogger({ write: () => {} });

const servers: Bun.Server<undefined>[] = [];
function start(probes: Probes): string {
  const server = startHealthServer({
    port: 0,
    hostname: "127.0.0.1",
    probes,
    logger,
    probeTimeoutMs: 50,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

describe("checkHealth", () => {
  test("is ok when every probe is up", async () => {
    expect(await checkHealth(allUp)).toEqual({
      ok: true,
      checks: { gateway: true, postgres: true, redis: true },
    });
  });

  test("a probe that throws counts as down", async () => {
    const report = await checkHealth({
      ...allUp,
      postgres: async () => {
        throw new Error("connection refused");
      },
    });
    expect(report).toEqual({ ok: false, checks: { gateway: true, postgres: false, redis: true } });
  });

  test("a probe that hangs counts as down once its timeout passes", async () => {
    const started = performance.now();
    const report = await checkHealth({ ...allUp, redis: () => new Promise(() => {}) }, 50);
    expect(report.checks).toEqual({ gateway: true, postgres: true, redis: false });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("health server", () => {
  test("answers 200 with the report when everything is up", async () => {
    const response = await fetch(`${start(allUp)}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      checks: { gateway: true, postgres: true, redis: true },
    });
  });

  test("answers 503 and names the failing check", async () => {
    const response = await fetch(`${start({ ...allUp, gateway: down })}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      checks: { gateway: false, postgres: true, redis: true },
    });
  });

  test("liveness stays 200 while every dependency is down", async () => {
    const base = start({ gateway: down, postgres: down, redis: down });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });

  test("unknown paths are 404 and other methods 405", async () => {
    const base = start(allUp);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
  });
});

describe("runHealthcheck", () => {
  test("exits 0 when the endpoint is ready", async () => {
    const port = new URL(start(allUp)).port;
    expect(await runHealthcheck({ HEALTH_PORT: port })).toBe(0);
  });

  test("exits 1 when a dependency is down", async () => {
    const port = new URL(start({ ...allUp, redis: down })).port;
    expect(await runHealthcheck({ HEALTH_PORT: port })).toBe(1);
  });

  test("exits 1 when nothing listens", async () => {
    const server = startHealthServer({
      port: 0,
      hostname: "127.0.0.1",
      probes: allUp,
      logger,
    });
    const { port } = server;
    await server.stop(true);
    expect(await runHealthcheck({ HEALTH_PORT: String(port) })).toBe(1);
  });
});
