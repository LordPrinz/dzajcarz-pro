import { withTimeout } from "@dzajcarz/core";

type CheckName = "postgres" | "redis";
export type Probes = Record<CheckName, () => Promise<boolean>>;

export interface HealthReport {
  ok: boolean;
  checks: Record<CheckName, boolean>;
}

/** Longest a single probe may take; a hanging database must not hang the endpoint (or a supervisor's check). */
const PROBE_TIMEOUT_MS = 2_000;

function runProbe(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  // A throwing probe counts as down, like a slow one.
  return withTimeout(probe(), timeoutMs).catch(() => false);
}

/**
 * Readiness: Postgres and Redis. The bot being down is not a failure here, since the panel has to work
 * (and say so) while the bot is away. Concurrent requests share one run.
 */
export function createHealth(probes: Probes, timeoutMs = PROBE_TIMEOUT_MS) {
  let inFlight: Promise<HealthReport> | undefined;
  return {
    check(): Promise<HealthReport> {
      inFlight ??= Promise.all([
        runProbe(probes.postgres, timeoutMs),
        runProbe(probes.redis, timeoutMs),
      ])
        .then(([postgres, redis]) => ({ ok: postgres && redis, checks: { postgres, redis } }))
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
