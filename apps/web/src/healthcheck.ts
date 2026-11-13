import { probeHealthEndpoint } from "@dzajcarz/core";

/**
 * A self-check for supervisors without curl: `web healthcheck` asks the running process's own endpoint and
 * returns the exit code. Reads only WEB_PORT, so it needs no database. The request goes to 127.0.0.1, which
 * the Host check allows.
 */
export const runHealthcheck = (env: Record<string, string | undefined>): Promise<0 | 1> =>
  probeHealthEndpoint(env.WEB_PORT || "3000", "WEB_PORT");
