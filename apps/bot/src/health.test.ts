import { afterEach, describe, expect, test } from "bun:test";
import { createJsonLogger } from "@dzajcarz/core";
import { Status } from "discord.js";
import { checkHealth, gatewayReady, type Probes, startHealthServer } from "./health.ts";
import { runHealthcheck } from "./healthcheck.ts";

const up = async () => true;
const down = async () => false;
const allUp: Probes = { gateway: up, postgres: up, redis: up };
const logger = createJsonLogger({ write: () => {} });

const servers: Bun.Server<undefined>[] = [];
function start(probes: Probes, probeTimeoutMs = 50): string {
  const server = startHealthServer({
    port: 0,
    hostname: "127.0.0.1",
    probes,
    logger,
    probeTimeoutMs,
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
  test("a probe that never settles does not block the checks after its timeout", async () => {
    let calls = 0;
    const base = start({
      ...allUp,
      redis: () => (++calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
    });
    expect((await fetch(`${base}/health`)).status).toBe(503);
    const second = await fetch(`${base}/health`);
    expect(second.status).toBe(200);
    expect(calls).toBe(2);
  });

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
    // Nothing listens on port 1 on dev machines or CI runners, so the connection is refused at once instead of
    // racing a freed ephemeral port.
    expect(await runHealthcheck({ HEALTH_PORT: "1" })).toBe(1);
  });

  test("exits 1 for a HEALTH_PORT that is not a port number", async () => {
    expect(await runHealthcheck({ HEALTH_PORT: "80@example.com" })).toBe(1);
    expect(await runHealthcheck({ HEALTH_PORT: "8080/x" })).toBe(1);
  });

  test("exits 1 when the endpoint is disabled with HEALTH_PORT=0", async () => {
    expect(await runHealthcheck({ HEALTH_PORT: "0" })).toBe(1);
  });
});

describe("a hung probe", () => {
  test("is started again only after the timeout of the earlier run has passed", async () => {
    let calls = 0;
    const hang = () => {
      calls++;
      return new Promise<boolean>(() => {});
    };
    const base = start({ ...allUp, postgres: hang });
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect(calls).toBe(2);
  });
});

describe("gatewayReady", () => {
  const shards = (...statuses: number[]) => new Map(statuses.map((status, id) => [id, { status }]));

  test("is ready when every shard is ready", () => {
    expect(gatewayReady(shards(Status.Ready, Status.Ready))).toBe(true);
  });

  test("is not ready while any shard reconnects or is disconnected", () => {
    expect(gatewayReady(shards(Status.Ready, Status.Reconnecting))).toBe(false);
    expect(gatewayReady(shards(Status.Disconnected))).toBe(false);
  });

  test("is not ready before any shard exists", () => {
    expect(gatewayReady(shards())).toBe(false);
  });
});

describe("coalescing", () => {
  test("concurrent requests share one probe run", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = start(
      {
        ...allUp,
        postgres: async () => {
          calls++;
          await gate;
          return true;
        },
      },
      5_000,
    );
    const pending = Array.from({ length: 5 }, () => fetch(`${base}/health`));
    // All five must be inside the server before the probe finishes, or a late one would start a second run.
    const server = servers.at(-1);
    while ((server?.pendingRequests ?? 0) < 5) await Bun.sleep(1);
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(calls).toBe(1);
    await fetch(`${base}/health`);
    expect(calls).toBe(2);
  });
});
