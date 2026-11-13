import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase } from "./testing.ts";
import { createUserSettingsRepository } from "./user-settings.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE user_settings`;
});

describe.skipIf(!sql)("user settings repository", () => {
  const repo = () => createUserSettingsRepository(sql as SQL);
  const userId = "1234567890123456789";

  test("find returns null for a member without settings", async () => {
    expect(await repo().find(userId)).toBeNull();
  });

  test("setLocale creates the row, updates it and clears it with null", async () => {
    expect((await repo().setLocale(userId, "en")).locale).toBe("en");
    expect((await repo().setLocale(userId, "de")).locale).toBe("de");
    expect((await repo().find(userId))?.locale).toBe("de");
    expect((await repo().setLocale(userId, null)).locale).toBeNull();
  });

  test("the database rejects a language the bot does not speak", async () => {
    await expect(repo().setLocale(userId, "fr")).rejects.toThrow();
  });
});
