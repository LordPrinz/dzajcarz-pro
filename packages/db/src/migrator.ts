import type { SQL } from "bun";

// import.meta.dir, not URL.pathname: the latter keeps %20 for spaces in the path.
export const MIGRATIONS_DIR = `${import.meta.dir}/../migrations/`;

/**
 * Applies `migrations/NNNN_name.sql` files in order, each in its own transaction,
 * and records them in `schema_migrations`. Applied files must never be edited.
 */
export async function migrate(sql: SQL, dir = MIGRATIONS_DIR): Promise<string[]> {
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

  const files = (await Array.fromAsync(new Bun.Glob("*.sql").scan(dir))).sort();
  const newlyApplied: string[] = [];

  for (const name of files) {
    const content = await Bun.file(`${dir}${name}`).text();
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
