import type { Logger } from "@dzajcarz/core";
import { Status } from "discord.js";

type CheckName = "gateway" | "postgres" | "redis";
export type Probes = Record<CheckName, () => Promise<boolean>>;

interface HealthReport {
  ok: boolean;
  checks: Record<CheckName, boolean>;
}

/** Longest a single probe may take; a hanging database must not hang the endpoint (or a supervisor's check). */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * discord.js sets `client.ws.status` to Ready once and never resets it; a dropped connection only changes the
 * status of the shard, so readiness has to look at every shard.
 */
export function gatewayReady(shards: {
  size: number;
  values(): Iterable<{ status: number }>;
}): boolean {
  return shards.size > 0 && [...shards.values()].every((shard) => shard.status === Status.Ready);
}

async function runProbe(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: Timer | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, false);
  });
  try {
    // A throwing probe counts as down, like a slow one.
    return await Promise.race([probe().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every probe in parallel, each with its own timeout. */
export async function checkHealth(
  probes: Probes,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HealthReport> {
  const [gateway, postgres, redis] = await Promise.all([
    runProbe(probes.gateway, timeoutMs),
    runProbe(probes.postgres, timeoutMs),
    runProbe(probes.redis, timeoutMs),
  ]);
  return { ok: gateway && postgres && redis, checks: { gateway, postgres, redis } };
}

interface HealthServerOptions {
  port: number;
  hostname: string;
  probes: Probes;
  logger: Logger;
  probeTimeoutMs?: number;
}

/**
 * `GET /health` is readiness: 200 when the gateway, Postgres and Redis answer, 503 otherwise.
 * `GET /health/live` is liveness: 200 whenever the process can answer at all, so a supervisor can tell
 * "restart me" (no answer) from "a dependency is down" (503, restarting would not help).
 */
export function startHealthServer({
  port,
  hostname,
  probes,
  logger,
  probeTimeoutMs,
}: HealthServerOptions): Bun.Server<undefined> {
  // A probe still pending from an earlier run is reused, so a hung database gets one `select 1`, not one per
  // request.
  const shared = Object.fromEntries(
    Object.entries(probes).map(([name, probe]) => {
      let pending: Promise<boolean> | undefined;
      return [
        name,
        () => {
          pending ??= probe().finally(() => {
            pending = undefined;
          });
          return pending;
        },
      ];
    }),
  ) as Probes;
  // Concurrent requests share one run, so hammering /health cannot queue up `select 1` and pings.
  let inFlight: Promise<HealthReport> | undefined;
  const server = Bun.serve({
    port,
    hostname,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (pathname === "/health/live") return Response.json({ ok: true });
      if (pathname !== "/health") return new Response("Not Found", { status: 404 });
      inFlight ??= checkHealth(shared, probeTimeoutMs).finally(() => {
        inFlight = undefined;
      });
      const report = await inFlight;
      return Response.json(report, { status: report.ok ? 200 : 503 });
    },
    error(error) {
      logger.error("Health endpoint failed", { error });
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  logger.info("Health endpoint listening", { hostname, port: server.port });
  return server;
}
