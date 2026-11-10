import type { SQL } from "bun";
import { MIGRATIONS, type Migration } from "./migrations.ts";

/** Where `db:new` writes new files. Only the scripts and tests read it; `migrate` uses the embedded list. */
// import.meta.dir, not URL.pathname: the latter keeps %20 for spaces in the path.
export const MIGRATIONS_DIR = `${import.meta.dir}/../migrations/`;

// Arbitrary, fixed key of the session-level advisory lock that serialises concurrent `migrate` calls.
export const MIGRATION_LOCK = 724_591_305;

/**
 * Applies the migrations in order, each in its own transaction, and records them in `schema_migrations`.
 * Applied files must never be edited. An advisory lock makes a second caller (another bot starting, or
 * `db:migrate` next to a running deploy) wait instead of applying the same migration twice, for at most
 * `lockTimeout` (a Postgres interval): then it throws.
 */
export async function migrate(
  sql: SQL,
  migrations: readonly Migration[] = MIGRATIONS,
  { lockTimeout = "60s" }: { lockTimeout?: string } = {},
): Promise<string[]> {
  const connection = await sql.reserve();
  let unlocked = false;
  try {
    // A caller stuck behind a lock that is never released fails instead of hanging the start forever.
    await connection`SELECT set_config('lock_timeout', ${lockTimeout}, false)`;
    await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    // The migrations themselves keep the server's default, and so does the pool after release.
    await connection`RESET lock_timeout`;
    try {
      return await applyPending(connection, migrations);
    } finally {
      // Never throws: a failed unlock must not replace the migration's own error.
      unlocked = await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`.then(
        () => true,
        () => false,
      );
    }
  } finally {
    // Closing ends the session, which drops a lock that is still held instead of pooling it. Neither may
    // replace the original error.
    await (unlocked ? connection.release() : connection.close()).catch(() => {});
  }
}

async function applyPending(sql: SQL, migrations: readonly Migration[]): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const applied = new Map<string, string>(
    (
      await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations`
    ).map((row) => [row.name, row.checksum]),
  );

  const newlyApplied: string[] = [];
  for (const { name, content } of migrations) {
    const checksum = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    const previous = applied.get(name);
    if (previous) {
      if (previous !== checksum)
        throw new Error(`Migration ${name} was modified after being applied`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})`;
    });
    newlyApplied.push(name);
  }
  return newlyApplied;
}
