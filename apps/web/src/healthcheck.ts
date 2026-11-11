/**
 * A self-check for supervisors without curl: `web healthcheck` asks the running process's own endpoint and
 * returns the exit code. Reads only WEB_PORT, so it needs no database. The request goes to 127.0.0.1, which
 * the Host check allows.
 */
export async function runHealthcheck(env: Record<string, string | undefined>): Promise<0 | 1> {
  const port = env.WEB_PORT || "3000";
  if (!/^\d{1,5}$/.test(port)) {
    console.error(`healthcheck: WEB_PORT must be a port number, got "${port}"`);
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
