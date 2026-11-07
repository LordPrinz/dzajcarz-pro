import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createModuleToggleRepository } from "./module-toggles.ts";
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
  if (sql) await sql`TRUNCATE module_disabled`;
});

describe.skipIf(!sql)("module toggle repository", () => {
  const repo = () => createModuleToggleRepository(sql as SQL);
  const guildId = "1234567890123456789";
  const channelId = "9876543210987654321";

  test("a guild with no rows has nothing disabled", async () => {
    expect(await repo().listDisabled(guildId)).toEqual([]);
  });

  test("disables a module for the whole guild and in one channel", async () => {
    await repo().disable(guildId, "music", null);
    await repo().disable(guildId, "welcome", channelId);
    expect(await repo().listDisabled(guildId)).toEqual([
      { module: "music", channelId: null },
      { module: "welcome", channelId },
    ]);
  });

  test("disabling twice keeps one row, also for the whole-guild entry", async () => {
    await repo().disable(guildId, "music", null);
    await repo().disable(guildId, "music", null);
    await repo().disable(guildId, "music", channelId);
    await repo().disable(guildId, "music", channelId);
    expect(await repo().listDisabled(guildId)).toHaveLength(2);
  });

  test("enable removes only the matching entry and reports whether it existed", async () => {
    await repo().disable(guildId, "music", null);
    await repo().disable(guildId, "music", channelId);

    expect(await repo().enable(guildId, "music", channelId)).toBe(true);
    expect(await repo().listDisabled(guildId)).toEqual([{ module: "music", channelId: null }]);
    expect(await repo().enable(guildId, "music", channelId)).toBe(false);
    expect(await repo().enable(guildId, "music", null)).toBe(true);
    expect(await repo().listDisabled(guildId)).toEqual([]);
  });

  test("guilds do not see each other's entries", async () => {
    await repo().disable(guildId, "music", null);
    expect(await repo().listDisabled("5555555555555555555")).toEqual([]);
  });

  test("the database rejects an empty module name", async () => {
    await expect(repo().disable(guildId, "", null)).rejects.toThrow();
  });
});
