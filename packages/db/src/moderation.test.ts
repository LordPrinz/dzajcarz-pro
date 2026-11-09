import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createModerationRepository, type NewModerationAction } from "./moderation.ts";
import { createTestDatabase } from "./testing.ts";
import type { ModerationActionRow } from "./types.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE moderation_action`;
});

const GUILD = "100000000000000001";
const MOD = "200000000000000002";
const TARGET = "500000000000000005";

function entry(overrides: Partial<NewModerationAction> = {}): NewModerationAction {
  return {
    guildId: GUILD,
    action: "warn",
    moderatorId: MOD,
    targetId: TARGET,
    channelId: null,
    reason: "spam",
    durationMs: null,
    messageCount: null,
    ...overrides,
  };
}

describe.skipIf(!sql)("moderation repository", () => {
  const repo = () => createModerationRepository(sql as SQL);

  test("record stores every field and returns the new id", async () => {
    const { id } = await repo().record(
      entry({ action: "timeout", durationMs: 28 * 86_400_000, reason: null }),
    );
    expect(typeof id).toBe("number");
    const [row] = await (sql as SQL)<ModerationActionRow[]>`
      SELECT * FROM moderation_action WHERE id = ${id}
    `;
    expect(row).toMatchObject({
      guild_id: GUILD,
      action: "timeout",
      moderator_id: MOD,
      target_id: TARGET,
      reason: null,
    });
    expect(Number(row?.duration_ms)).toBe(28 * 86_400_000);
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  test("a purge is stored with the channel and the count, without a target", async () => {
    await repo().record(
      entry({ action: "purge", targetId: null, channelId: "3", messageCount: 0, reason: null }),
    );
    const [row] = await (sql as SQL)<ModerationActionRow[]>`SELECT * FROM moderation_action`;
    expect(row).toMatchObject({
      action: "purge",
      target_id: null,
      channel_id: "3",
      message_count: 0,
    });
  });

  test("warnings counts only the user's warnings in that guild and lists the newest first", async () => {
    const older = await repo().record(entry({ reason: "1" }));
    const second = await repo().record(entry({ reason: "2" }));
    const third = await repo().record(entry({ reason: "3" }));
    await repo().record(entry({ action: "kick" }));
    await repo().record(entry({ guildId: "999" }));
    await repo().record(entry({ targetId: "777" }));
    // Order follows created_at, not the id.
    await (sql as SQL)`
      UPDATE moderation_action SET created_at = now() + interval '1 day' WHERE id = ${older.id}
    `;

    const { total, recent } = await repo().warnings(GUILD, TARGET, 2);
    expect(total).toBe(3);
    expect(recent.map((warning) => warning.id)).toEqual([older.id, third.id]);
    expect(second.id).toBeLessThan(third.id);
    expect(recent[0]).toMatchObject({ moderatorId: MOD, reason: "1" });
    expect(recent[0]?.createdAt).toBeInstanceOf(Date);
  });

  test("a limit of 0 only counts", async () => {
    await repo().record(entry());
    expect(await repo().warnings(GUILD, TARGET, 0)).toEqual({ total: 1, recent: [] });
    expect(await repo().warnings(GUILD, "nobody", 10)).toEqual({ total: 0, recent: [] });
  });

  test("constraints reject a purge with a target and other actions without one", async () => {
    await expect(
      repo().record(entry({ action: "purge", channelId: "3", messageCount: 1 })),
    ).rejects.toThrow();
    await expect(repo().record(entry({ targetId: null }))).rejects.toThrow();
  });

  test("constraints tie the duration to timeouts and the channel and count to purges", async () => {
    await expect(repo().record(entry({ action: "timeout" }))).rejects.toThrow();
    await expect(repo().record(entry({ durationMs: 1000 }))).rejects.toThrow();
    await expect(repo().record(entry({ action: "timeout", durationMs: 0 }))).rejects.toThrow();
    await expect(repo().record(entry({ channelId: "3" }))).rejects.toThrow();
    await expect(
      repo().record(entry({ action: "purge", targetId: null, channelId: "3" })),
    ).rejects.toThrow();
  });

  test("constraints reject unknown actions and reasons over 512 characters", async () => {
    await expect(
      repo().record(entry({ action: "mute" as NewModerationAction["action"] })),
    ).rejects.toThrow();
    await expect(repo().record(entry({ reason: "ż".repeat(513) }))).rejects.toThrow();
    await repo().record(entry({ reason: "ż".repeat(512) }));
  });

  test("untimeout is a valid action", async () => {
    await repo().record(entry({ action: "untimeout" }));
    const { total } = await repo().warnings(GUILD, TARGET, 0);
    expect(total).toBe(0);
  });
});
