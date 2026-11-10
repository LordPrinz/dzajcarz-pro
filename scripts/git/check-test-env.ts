// Warns, without blocking the push, when bun test skipped the suites that need Postgres or Redis.
export function skippedSuitesWarning(env: Record<string, string | undefined>): string[] {
  const skipped: string[] = [];
  if (!env.TEST_DATABASE_URL) skipped.push("database (TEST_DATABASE_URL)");
  if (!env.TEST_REDIS_URL) skipped.push("Redis (TEST_REDIS_URL)");
  if (skipped.length === 0) return [];
  return [
    `Warning: these test suites were skipped locally and only run in CI: ${skipped.join(", ")}`,
    "To run them, start the infra and set the TEST_* variables from .env.example in .env.",
  ];
}

if (import.meta.main) {
  for (const line of skippedSuitesWarning(Bun.env)) console.warn(line);
}
