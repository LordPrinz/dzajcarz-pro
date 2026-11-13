import { probeHealthEndpoint } from "@dzajcarz/core";

/**
 * A self-check for supervisors without curl: `bot healthcheck` asks the running process's own endpoint and
 * returns the exit code. Reads only HEALTH_PORT, so it needs no token or database.
 */
export function runHealthcheck(env: Record<string, string | undefined>): Promise<0 | 1> {
  // env.ts reads a blank HEALTH_PORT as unset, so the check has to look where the server listens.
  const port = env.HEALTH_PORT?.trim() || "8080";
  if (port === "0") {
    console.error(
      "healthcheck: HEALTH_PORT=0 disables the health endpoint, so there is nothing to check",
    );
    return Promise.resolve(1);
  }
  return probeHealthEndpoint(port, "HEALTH_PORT");
}
