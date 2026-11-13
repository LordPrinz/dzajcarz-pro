import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createBirthdayRepository } from "./birthdays.ts";
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
  if (sql) await sql`TRUNCATE birthday, birthday_config, birthday_wish`;
});

describe.skipIf(!sql)("birthday repository", () => {
  const repo = () => createBirthdayRepository(sql as SQL);
  const ola = "1000000000000000001";
  const jan = "1000000000000000002";
  const guildId = "2000000000000000001";
  const channelId = "3000000000000000001";

  test("set stores the birthday, a second set replaces it and remove deletes it", async () => {
    expect(await repo().get(ola)).toBeNull();
    await repo().set(ola, { month: 3, day: 12 });
    expect(await repo().get(ola)).toEqual({ month: 3, day: 12 });
    await repo().set(ola, { month: 2, day: 29 });
    expect(await repo().get(ola)).toEqual({ month: 2, day: 29 });
    expect(await repo().remove(ola)).toBe(true);
    expect(await repo().get(ola)).toBeNull();
    expect(await repo().remove(ola)).toBe(false);
  });

  test("the database refuses a date that does not exist", async () => {
    for (const [month, day] of [
      [2, 30],
      [4, 31],
      [13, 1],
      [0, 1],
      [1, 0],
      [1, 32],
    ] as const) {
      await expect(repo().set(ola, { month, day })).rejects.toThrow();
    }
  });

  test("unwished lists members born on the days who have no wish for the target and year", async () => {
    await repo().set(ola, { month: 2, day: 28 });
    await repo().set(jan, { month: 2, day: 29 });
    await repo().set("1000000000000000003", { month: 3, day: 1 });
    expect(await repo().unwished(guildId, 2027, 2, [28, 29])).toEqual([ola, jan]);
    expect(await repo().unwished(guildId, 2028, 2, [28])).toEqual([ola]);
    await repo().claimWish(ola, guildId, 2027);
    expect(await repo().unwished(guildId, 2027, 2, [28, 29])).toEqual([jan]);
    // Another server, the DM and another year are wished separately.
    expect(await repo().unwished("2000000000000000002", 2027, 2, [28])).toEqual([ola]);
    expect(await repo().unwished("dm", 2027, 2, [28])).toEqual([ola]);
    expect(await repo().unwished(guildId, 2028, 2, [28])).toEqual([ola]);
  });

  test("a wish is claimed once per member, target and year, and a release frees it", async () => {
    expect(await repo().claimWish(ola, guildId, 2026)).toBe(true);
    expect(await repo().claimWish(ola, guildId, 2026)).toBe(false);
    expect(await repo().claimWish(ola, "dm", 2026)).toBe(true);
    expect(await repo().claimWish(ola, guildId, 2027)).toBe(true);
    await repo().releaseWish(ola, guildId, 2026);
    expect(await repo().claimWish(ola, guildId, 2026)).toBe(true);
  });

  test("configs are stored per guild, replaced, listed and deleted", async () => {
    expect(await repo().getConfig(guildId)).toBeNull();
    await repo().setConfig(guildId, { channelId, template: "Sto lat {user}" });
    await repo().setConfig(guildId, { channelId, template: "Wszystkiego najlepszego {user}" });
    await repo().setConfig("2000000000000000002", { channelId: "1", template: "x" });
    expect(await repo().getConfig(guildId)).toEqual({
      channelId,
      template: "Wszystkiego najlepszego {user}",
    });
    expect(await repo().configs()).toEqual([
      { guildId, channelId, template: "Wszystkiego najlepszego {user}" },
      { guildId: "2000000000000000002", channelId: "1", template: "x" },
    ]);
    expect(await repo().deleteConfig(guildId)).toBe(true);
    expect(await repo().deleteConfig(guildId)).toBe(false);
    expect(await repo().getConfig(guildId)).toBeNull();
  });

  test("the database accepts a 2000 character template and rejects 2001 or none", async () => {
    await repo().setConfig(guildId, { channelId, template: "a".repeat(2000) });
    await expect(
      repo().setConfig(guildId, { channelId, template: "a".repeat(2001) }),
    ).rejects.toThrow();
    await expect(repo().setConfig(guildId, { channelId, template: "" })).rejects.toThrow();
  });
});
