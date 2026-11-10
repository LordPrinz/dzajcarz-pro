import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createDzajcoRepository } from "./dzajco.ts";
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
  if (sql) await sql`TRUNCATE dzajco_channel_config`;
});

describe.skipIf(!sql)("dzajco repository", () => {
  const repo = () => createDzajcoRepository(sql as SQL);
  const guildId = "1234567890123456789";
  const channelId = "9876543210987654321";
  const otherChannelId = "9876543210987654322";

  test("a channel without an override returns null", async () => {
    expect(await repo().get(guildId, channelId)).toBeNull();
  });

  test("set stores the override and a second set replaces it", async () => {
    await repo().set(guildId, channelId, { chancePercent: 10, cooldownSeconds: 30 });
    expect(await repo().get(guildId, channelId)).toEqual({
      chancePercent: 10,
      cooldownSeconds: 30,
    });

    await repo().set(guildId, channelId, { chancePercent: 0, cooldownSeconds: 0 });
    expect(await repo().get(guildId, channelId)).toEqual({ chancePercent: 0, cooldownSeconds: 0 });
  });

  test("channels are independent", async () => {
    await repo().set(guildId, channelId, { chancePercent: 50, cooldownSeconds: 5 });
    expect(await repo().get(guildId, otherChannelId)).toBeNull();
  });

  test("clear reports whether a row was removed", async () => {
    await repo().set(guildId, channelId, { chancePercent: 50, cooldownSeconds: 5 });
    expect(await repo().clear(guildId, channelId)).toBe(true);
    expect(await repo().get(guildId, channelId)).toBeNull();
    expect(await repo().clear(guildId, channelId)).toBe(false);
  });

  test("the CHECK constraints accept the bounds and refuse values outside them", async () => {
    await repo().set(guildId, channelId, { chancePercent: 100, cooldownSeconds: 86400 });
    await expect(
      repo().set(guildId, channelId, { chancePercent: 101, cooldownSeconds: 60 }),
    ).rejects.toThrow();
    await expect(
      repo().set(guildId, channelId, { chancePercent: -1, cooldownSeconds: 60 }),
    ).rejects.toThrow();
    await expect(
      repo().set(guildId, channelId, { chancePercent: 3, cooldownSeconds: 86401 }),
    ).rejects.toThrow();
    await expect(
      repo().set(guildId, channelId, { chancePercent: 3, cooldownSeconds: -1 }),
    ).rejects.toThrow();
  });
});
