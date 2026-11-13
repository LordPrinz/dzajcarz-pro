import { withTimeout } from "./timeout.ts";

export interface HealthReport<Name extends string = string> {
  ok: boolean;
  checks: Record<Name, boolean>;
}

/** Longest a single probe may take; a hanging database must not hang the endpoint (or a supervisor's check). */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Runs every probe in parallel, each with its own timeout; a throwing probe counts as down, like a slow one.
 * Concurrent callers share one run, and a probe still pending from an earlier run is reused, so a hung
 * database gets one `select 1` per timeout window, not one per request.
 */
export function createHealthChecker<Name extends string>(
  probes: Record<Name, () => Promise<boolean>>,
  timeoutMs = PROBE_TIMEOUT_MS,
): () => Promise<HealthReport<Name>> {
  const names = Object.keys(probes) as Name[];
  const pending = new Map<Name, Promise<boolean>>();

  function runShared(name: Name): Promise<boolean> {
    const running = pending.get(name);
    if (running) return running;
    const run: Promise<boolean> = Promise.resolve()
      .then(probes[name])
      .finally(() => {
        clearTimeout(forget);
        if (pending.get(name) === run) pending.delete(name);
      });
    // A probe that never settles must not block every later check: drop it once its timeout has passed. The
    // identity check keeps a newer probe from being dropped by an older timer.
    const forget = setTimeout(() => {
      if (pending.get(name) === run) pending.delete(name);
    }, timeoutMs);
    pending.set(name, run);
    return run;
  }

  let inFlight: Promise<HealthReport<Name>> | undefined;
  return () => {
    inFlight ??= Promise.all(
      names.map((name) => withTimeout(runShared(name), timeoutMs).catch(() => false)),
    )
      .then((results) => {
        const checks = Object.fromEntries(names.map((name, i) => [name, results[i]])) as Record<
          Name,
          boolean
        >;
        return { ok: results.every(Boolean), checks };
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/**
 * The two health routes: readiness is 200 while every probe answers and 503 otherwise; liveness is 200
 * whenever the process can answer at all, so a supervisor can tell "restart me" (no answer) from "a
 * dependency is down" (503, restarting would not help).
 */
export function healthHandlers(check: () => Promise<HealthReport>) {
  return {
    async readiness() {
      const report = await check();
      return Response.json(report, { status: report.ok ? 200 : 503 });
    },
    liveness: () => Response.json({ ok: true }),
  };
}

/**
 * The self-check behind `<app> healthcheck`, for supervisors without curl: asks the running process's own
 * readiness endpoint and returns the exit code.
 */
export async function probeHealthEndpoint(port: string, variable: string): Promise<0 | 1> {
  if (!/^\d{1,5}$/.test(port)) {
    console.error(`healthcheck: ${variable} must be a port number, got "${port}"`);
    return 1;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}
