import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createGuildSettingsRepository } from "./guild-settings.ts";
import { createTestDatabase } from "./testing.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE guild_settings`;
});

describe.skipIf(!sql)("guild settings repository", () => {
  const repo = () => createGuildSettingsRepository(sql as SQL);
  // Above Number.MAX_SAFE_INTEGER, like real snowflakes.
  const guildId = "1234567890123456789";

  test("find returns null for a guild without settings", async () => {
    expect(await repo().find(guildId)).toBeNull();
  });

  test("setPrefix creates the row, then updates it", async () => {
    const created = await repo().setPrefix(guildId, "?");
    expect(created).toMatchObject({ guild_id: guildId, prefix: "?" });

    const updated = await repo().setPrefix(guildId, "$$");
    expect(updated.prefix).toBe("$$");
    expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(created.updated_at.getTime());
    expect((await repo().find(guildId))?.prefix).toBe("$$");
  });

  test("setPrefix(null) resets to the default", async () => {
    await repo().setPrefix(guildId, "?");
    expect((await repo().setPrefix(guildId, null)).prefix).toBeNull();
  });

  test("the database rejects a prefix longer than 5 characters", async () => {
    await expect(repo().setPrefix(guildId, "toolong")).rejects.toThrow();
  });
});
