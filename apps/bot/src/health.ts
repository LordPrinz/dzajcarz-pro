import type { Logger } from "@dzajcarz/core";

export type CheckName = "gateway" | "postgres" | "redis";
export type Probes = Record<CheckName, () => Promise<boolean>>;

export interface HealthReport {
  ok: boolean;
  checks: Record<CheckName, boolean>;
}

/** Longest a single probe may take; a hanging database must not hang the endpoint (or Docker's check). */
export const PROBE_TIMEOUT_MS = 2_000;

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

export interface HealthServerOptions {
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
  const server = Bun.serve({
    port,
    hostname,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (pathname === "/health/live") return Response.json({ ok: true });
      if (pathname !== "/health") return new Response("Not Found", { status: 404 });
      const report = await checkHealth(probes, probeTimeoutMs);
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
