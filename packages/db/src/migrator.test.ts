import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "./migrator.ts";

// Integration test: runs only when a disposable database is available (CI provides one).
const url = Bun.env.TEST_DATABASE_URL;
const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
const sql = url ? new SQL({ url, max: 1 }) : undefined;

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.close();
});

describe.skipIf(!sql)("migrator", () => {
  test("applies all migrations once and is idempotent", async () => {
    const db = sql as SQL;
    await db.unsafe(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);

    const first = await migrate(db);
    expect(first.length).toBeGreaterThan(0);
    expect(await migrate(db)).toEqual([]);

    const tables = await db<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema}
    `;
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      "guild_settings",
      "module_disabled",
      "party_area",
      "party_channel",
      "scheduled_song_config",
      "scheduled_song_exclusion",
      "schema_migrations",
      "welcome_config",
    ]);
  });
});
