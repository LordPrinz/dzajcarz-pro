import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { MIGRATIONS } from "./migrations.ts";
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

describe("migrator lock", () => {
  // A connection whose every query fails, the unlock included, as when the database goes away mid-run.
  function failingConnection() {
    const calls: string[] = [];
    const connection = (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      calls.push(text.includes("unlock") ? "unlock" : text.includes("lock") ? "lock" : "query");
      if (text.includes("CREATE TABLE")) return Promise.reject(new Error("migration failed"));
      if (text.includes("unlock")) return Promise.reject(new Error("unlock failed"));
      return Promise.resolve([]);
    };
    const reserved = Object.assign(connection, {
      release: async () => void calls.push("release"),
      close: async () => void calls.push("close"),
    });
    return { sql: { reserve: async () => reserved } as unknown as SQL, calls };
  }

  test("a failed unlock keeps the migration's error and closes the connection", async () => {
    const { sql: failing, calls } = failingConnection();
    await expect(migrate(failing)).rejects.toThrow("migration failed");
    expect(calls).toEqual(["lock", "query", "unlock", "close"]);
  });
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
      "dzajco_channel_config",
      "guild_settings",
      "moderation_action",
      "module_disabled",
      "party_area",
      "party_channel",
      "scheduled_message",
      "scheduled_message_opt_out",
      "scheduled_song_config",
      "scheduled_song_exclusion",
      "schema_migrations",
      "welcome_config",
    ]);
  });

  test("applies each migration once when two callers race", async () => {
    const raceSchema = `${schema}_race`;
    await (sql as SQL).unsafe(`CREATE SCHEMA ${raceSchema}`);
    const pool = new SQL({ url, max: 2, connection: { search_path: raceSchema } });
    try {
      const [first, second] = await Promise.all([migrate(pool), migrate(pool)]);
      expect([...(first ?? []), ...(second ?? [])].sort()).toEqual(
        MIGRATIONS.map((migration) => migration.name),
      );
    } finally {
      await pool.close();
      await (sql as SQL).unsafe(`DROP SCHEMA IF EXISTS ${raceSchema} CASCADE`);
    }
  });
});
