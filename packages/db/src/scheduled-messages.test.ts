import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createGuildSettingsRepository } from "./guild-settings.ts";
import {
  createScheduledMessageRepository,
  type ScheduledMessageRecord,
  type ScheduledMessageTarget,
} from "./scheduled-messages.ts";
import { createTestDatabase } from "./testing.ts";

// Several connections, so concurrent adds really run side by side.
const testDb = createTestDatabase(6);
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE scheduled_message, scheduled_message_opt_out, guild_settings`;
});

describe.skipIf(!sql)("scheduled message repository", () => {
  const repo = () =>
    createScheduledMessageRepository(sql as SQL, { defaultTimeZone: "Europe/Warsaw" });
  const guild = "1234567890123456789";
  const otherGuild = "1234567890123456790";
  const channel = { kind: "channel", channelId: "400000000000000004" } as const;
  const member = "200000000000000005";
  const admin = "200000000000000002";
  const limits = { perGuild: 25, perRecipient: 3 };
  const dmTo = (userId: string) => ({ kind: "dm", userId }) as const;

  /** Adds a message that must be accepted and returns it. */
  async function add(
    guildId: string,
    time: string,
    content: string,
    target: ScheduledMessageTarget = channel,
  ): Promise<ScheduledMessageRecord> {
    const result = await repo().add({ guildId, time, content, target, createdBy: admin }, limits);
    if (result.status !== "added") throw new Error(`not added: ${result.status}`);
    return result.message;
  }

  const count = async (guildId: string) => (await repo().list(guildId)).length;

  test("add returns the stored message; list goes by time, then id", async () => {
    const late = await add(guild, "21:00", "Dobranoc");
    expect(late).toEqual({
      id: expect.any(Number),
      guildId: guild,
      time: "21:00",
      content: "Dobranoc",
      target: channel,
      createdBy: admin,
    });
    const dm = await add(guild, "09:00", "Hej {user}", dmTo(member));
    const early = await add(guild, "09:00", "Rano");
    await add(otherGuild, "08:00", "Obcy");
    expect((await repo().list(guild)).map((m) => m.id)).toEqual([dm.id, early.id, late.id]);
    expect((await repo().list(guild))[0]?.target).toEqual(dmTo(member));
    expect(await count("999")).toBe(0);
  });

  // 17:00 UTC on 1 July is 19:00 in Warsaw (summer time) and 18:00 in London.
  const SEVEN_PM_WARSAW = new Date("2026-07-01T17:00:00Z");

  test("due returns the messages of every guild at that time, up to the limit", async () => {
    await add(guild, "19:00", "A");
    await add(otherGuild, "19:00", "B");
    await add(guild, "19:01", "C");
    expect((await repo().due(SEVEN_PM_WARSAW, 500)).map((m) => m.content)).toEqual(["A", "B"]);
    expect((await repo().due(SEVEN_PM_WARSAW, 1)).map((m) => m.content)).toEqual(["A"]);
    expect(await repo().due(new Date("2026-07-01T22:00:00Z"), 500)).toEqual([]);
  });

  test("due reads each guild's own time zone and gives the date on its clock", async () => {
    await add(guild, "19:00", "Warszawa");
    await add(otherGuild, "18:00", "Londyn");
    await add(otherGuild, "19:00", "Nie teraz");
    await createGuildSettingsRepository(sql as SQL).setTimeZone(otherGuild, "Europe/London");
    const due = await repo().due(SEVEN_PM_WARSAW, 500);
    expect(due.map((m) => [m.content, m.date])).toEqual([
      ["Warszawa", "2026-07-01"],
      ["Londyn", "2026-07-01"],
    ]);
    // 23:30 UTC is already the next day in Warsaw.
    await add(guild, "01:30", "Po północy");
    const late = await repo().due(new Date("2026-07-01T23:30:00Z"), 500);
    expect(late.map((m) => [m.content, m.date])).toEqual([["Po północy", "2026-07-02"]]);
  });

  test("remove only takes a message of the given guild", async () => {
    const message = await add(guild, "19:00", "A");
    expect(await repo().remove(otherGuild, message.id)).toBe(false);
    expect(await count(guild)).toBe(1);
    expect(await repo().remove(guild, message.id)).toBe(true);
    expect(await repo().remove(guild, message.id)).toBe(false);
  });

  test("add refuses a guild at its cap", async () => {
    for (let i = 0; i < 3; i++) await add(guild, `1${i}:00`, `${i}`);
    const result = await repo().add(
      { guildId: guild, time: "19:00", content: "x", target: channel, createdBy: admin },
      { perGuild: 3, perRecipient: 3 },
    );
    expect(result).toEqual({ status: "guild-full" });
    expect(await count(guild)).toBe(3);
  });

  test("add refuses a fourth DM to the same member of a guild, not to others or elsewhere", async () => {
    for (const time of ["10:00", "11:00", "12:00"]) await add(guild, time, "x", dmTo(member));
    const fourth = await repo().add(
      { guildId: guild, time: "13:00", content: "x", target: dmTo(member), createdBy: admin },
      limits,
    );
    expect(fourth).toEqual({ status: "recipient-full" });
    await add(guild, "13:00", "x", dmTo("200000000000000009"));
    await add(otherGuild, "13:00", "x", dmTo(member));
    await add(guild, "13:00", "x");
  });

  test("add refuses the same target at the same time, for channels and DMs", async () => {
    await add(guild, "19:00", "A");
    await add(guild, "19:00", "A", dmTo(member));
    for (const target of [channel, dmTo(member)]) {
      const again = await repo().add(
        { guildId: guild, time: "19:00", content: "B", target, createdBy: admin },
        limits,
      );
      expect(again).toEqual({ status: "duplicate" });
    }
    await add(guild, "19:01", "A");
    await add(otherGuild, "19:00", "A");
  });

  test("concurrent adds never take a guild past its cap", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repo().add(
          {
            guildId: guild,
            time: `${String(i).padStart(2, "0")}:00`,
            content: `${i}`,
            target: channel,
            createdBy: admin,
          },
          { perGuild: 5, perRecipient: 3 },
        ),
      ),
    );
    expect(results.filter((result) => result.status === "added")).toHaveLength(5);
    expect(results.filter((result) => result.status === "guild-full")).toHaveLength(7);
    expect(await count(guild)).toBe(5);
  });

  test("a message needs exactly one target, a real time and 1-1900 characters", async () => {
    const insert = (
      channelId: string | null,
      userId: string | null,
      time = "19:00",
      content = "x",
    ) =>
      (sql as SQL)`
        INSERT INTO scheduled_message (guild_id, time_of_day, content, channel_id, user_id, created_by)
        VALUES (${guild}, ${time}, ${content}, ${channelId}, ${userId}, ${admin})
      `;
    await expect(insert(null, null)).rejects.toThrow();
    await expect(insert("1", "2")).rejects.toThrow();
    await expect(insert("1", null, "24:00")).rejects.toThrow();
    await expect(insert("1", null, "7:05")).rejects.toThrow();
    await expect(insert("1", null, "19:00", "")).rejects.toThrow();
    await expect(insert("1", null, "19:00", "ż".repeat(1901))).rejects.toThrow();
    await insert("1", null, "19:00", "ż".repeat(1900));
    expect(await count(guild)).toBe(1);
  });

  test("an opt-out is stored once per guild, and once for every server", async () => {
    expect(await repo().optOut(member, guild)).toBe(true);
    expect(await repo().optOut(member, guild)).toBe(false);
    expect(await repo().optOut(member, null)).toBe(true);
    expect(await repo().optOut(member, null)).toBe(false);
    const [row] = await (sql as SQL)<{ count: number }[]>`
      SELECT count(*)::int AS count FROM scheduled_message_opt_out
    `;
    expect(row?.count).toBe(2);
  });

  test("isOptedOut sees the guild's own opt-out and the every-server one", async () => {
    expect(await repo().isOptedOut(member, guild)).toBe(false);
    await repo().optOut(member, guild);
    expect(await repo().isOptedOut(member, guild)).toBe(true);
    expect(await repo().isOptedOut(member, otherGuild)).toBe(false);
    await repo().optOut(member, null);
    expect(await repo().isOptedOut(member, otherGuild)).toBe(true);
    expect(await repo().isOptedOut("200000000000000009", otherGuild)).toBe(false);
  });

  test("optIn removes exactly the opt-out it names", async () => {
    await repo().optOut(member, guild);
    await repo().optOut(member, null);
    expect(await repo().optIn(member, null)).toBe(true);
    expect(await repo().optIn(member, null)).toBe(false);
    expect(await repo().isOptedOut(member, guild)).toBe(true);
    expect(await repo().isOptedOut(member, otherGuild)).toBe(false);
    expect(await repo().optIn(member, guild)).toBe(true);
    expect(await repo().isOptedOut(member, guild)).toBe(false);
  });
});
