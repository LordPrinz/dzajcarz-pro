import { SQL } from "bun";
import { migrate } from "./migrator.ts";

export interface TestDatabase {
  /** Pool whose connections all use a fresh, migrated schema. */
  sql: SQL;
  setup(): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * A throwaway schema in the database at TEST_DATABASE_URL, or undefined when none is configured (DB tests
 * are then skipped). Call setup() in beforeAll and teardown() in afterAll.
 */
export function createTestDatabase(maxConnections = 2): TestDatabase | undefined {
  const url = Bun.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL({ url, max: 1 });
  const sql = new SQL({ url, max: maxConnections, connection: { search_path: schema } });
  return {
    sql,
    async setup() {
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      await migrate(sql);
    },
    async teardown() {
      await sql.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    },
  };
}
