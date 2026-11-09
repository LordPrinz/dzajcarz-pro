/**
 * The Docker HEALTHCHECK for the compiled binary (it has no curl): `bot healthcheck` asks the running
 * process's own endpoint and returns the exit code. Reads only HEALTH_PORT, so it needs no token or database.
 */
export async function runHealthcheck(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): Promise<0 | 1> {
  const port = env.HEALTH_PORT || "8080";
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}
