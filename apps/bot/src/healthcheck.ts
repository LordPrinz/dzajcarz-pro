/**
 * The Docker HEALTHCHECK for the compiled binary (it has no curl): `bot healthcheck` asks the running
 * process's own endpoint and returns the exit code. Reads only HEALTH_PORT, so it needs no token or database.
 */
export async function runHealthcheck(env: Record<string, string | undefined>): Promise<0 | 1> {
  const port = env.HEALTH_PORT || "8080";
  if (port === "0") {
    console.error(
      "healthcheck: HEALTH_PORT=0 disables the health endpoint, so there is nothing to check",
    );
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
