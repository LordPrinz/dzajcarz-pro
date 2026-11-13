import { createHealthChecker, healthHandlers, type Logger } from "@dzajcarz/core";
import { Status } from "discord.js";

export type Probes = Record<"gateway" | "postgres" | "redis", () => Promise<boolean>>;

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

interface HealthServerOptions {
  port: number;
  hostname: string;
  probes: Probes;
  logger: Logger;
  probeTimeoutMs?: number;
}

/**
 * `GET /health` is readiness: 200 when the gateway, Postgres and Redis answer, 503 otherwise.
 * `GET /health/live` is liveness: 200 whenever the process can answer at all.
 */
export function startHealthServer({
  port,
  hostname,
  probes,
  logger,
  probeTimeoutMs,
}: HealthServerOptions): Bun.Server<undefined> {
  const { readiness, liveness } = healthHandlers(createHealthChecker(probes, probeTimeoutMs));
  const server = Bun.serve({
    port,
    hostname,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (pathname === "/health/live") return liveness();
      if (pathname !== "/health") return new Response("Not Found", { status: 404 });
      return readiness();
    },
    error(error) {
      logger.error("Health endpoint failed", { error });
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  logger.info("Health endpoint listening", { hostname, port: server.port });
  return server;
}
