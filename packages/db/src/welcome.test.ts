import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase } from "./testing.ts";
import { createWelcomeRepository } from "./welcome.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE welcome_config`;
});

describe.skipIf(!sql)("welcome repository", () => {
  const repo = () => createWelcomeRepository(sql as SQL);
  const guildId = "1234567890123456789";
  const channelId = "9876543210987654321";

  test("a guild without config returns null", async () => {
    expect(await repo().get(guildId)).toBeNull();
  });

  test("set stores the config and a second set replaces it", async () => {
    await repo().set(guildId, { channelId, template: "Hej {user}" });
    expect(await repo().get(guildId)).toEqual({ channelId, template: "Hej {user}" });
    await repo().set(guildId, { channelId: "1", template: "Siema" });
    expect(await repo().get(guildId)).toEqual({ channelId: "1", template: "Siema" });
  });

  test("delete reports whether there was a config", async () => {
    await repo().set(guildId, { channelId, template: "x" });
    expect(await repo().delete(guildId)).toBe(true);
    expect(await repo().get(guildId)).toBeNull();
    expect(await repo().delete(guildId)).toBe(false);
  });

  test("guilds do not see each other's config", async () => {
    await repo().set(guildId, { channelId, template: "x" });
    expect(await repo().get("5555555555555555555")).toBeNull();
  });

  test("the database accepts 2000 characters and rejects 2001 or none", async () => {
    await repo().set(guildId, { channelId, template: "a".repeat(2000) });
    await expect(repo().set(guildId, { channelId, template: "a".repeat(2001) })).rejects.toThrow();
    await expect(repo().set(guildId, { channelId, template: "" })).rejects.toThrow();
  });
});
