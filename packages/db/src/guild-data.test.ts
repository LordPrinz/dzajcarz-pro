import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createArchiveSettingsRepository } from "./archive-settings.ts";
import { createDzajcoRepository } from "./dzajco.ts";
import { createGuildDataRepository, GUILD_TABLES, KEPT_GUILD_TABLES } from "./guild-data.ts";
import { createGuildSettingsRepository } from "./guild-settings.ts";
import { createModerationRepository } from "./moderation.ts";
import { createModuleToggleRepository } from "./module-toggles.ts";
import { createPartyRepository } from "./party.ts";
import { createScheduledMessageRepository } from "./scheduled-messages.ts";
import { createScheduledSongRepository } from "./scheduled-songs.ts";
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
  // Test-only SQL built from the constant table list.
  if (sql)
    await sql.unsafe(`TRUNCATE ${[...GUILD_TABLES, ...KEPT_GUILD_TABLES].join(", ")} CASCADE`);
});

const GONE = "1000000000000000001";
const STAYS = "1000000000000000002";

/** Stores one of everything for the guild; `n` keeps the channel ids of two guilds apart. */
async function fill(db: SQL, guildId: string, n: number) {
  const id = (suffix: number) => `${n}00000000000000${suffix}`;
  await createGuildSettingsRepository(db).setPrefix(guildId, "?");
  await createModuleToggleRepository(db).disable(guildId, "fun", null);
  await createWelcomeRepository(db).set(guildId, { channelId: id(1), template: "Cześć {user}" });
  const party = createPartyRepository(db);
  await party.addArea({
    guildId,
    categoryId: id(2),
    joinChannelId: id(3),
    nameTemplate: "Kanał {user}",
    commandChannel: false,
  });
  await party.addChannel({ channelId: id(4), guildId, ownerId: id(5), joinChannelId: id(3) });
  const songs = createScheduledSongRepository(db);
  await songs.setSong(guildId, "lato_z_radiem");
  await songs.addExcluded(guildId, id(6));
  await createDzajcoRepository(db).set(guildId, id(7), { chancePercent: 5, cooldownSeconds: 1 });
  await createModerationRepository(db).record({
    guildId,
    action: "warn",
    moderatorId: id(5),
    targetId: id(8),
    channelId: null,
    reason: null,
    durationMs: null,
    messageCount: null,
  });
  const messages = createScheduledMessageRepository(db, { defaultTimeZone: "Europe/Warsaw" });
  await messages.add(
    {
      guildId,
      time: "19:00",
      content: "x",
      target: { kind: "channel", channelId: id(1) },
      createdBy: id(5),
    },
    { perGuild: 25, perRecipient: 3 },
  );
  await messages.optOut(id(8), guildId);
  await createArchiveSettingsRepository(db).setGuild({
    guildId,
    enabled: true,
    excludedChannelIds: [id(1)],
  });
}

async function countsOf(db: SQL, guildId: string) {
  const counts: Record<string, number> = {};
  for (const table of GUILD_TABLES) {
    const [row] = await db.unsafe<{ count: string }[]>(
      `SELECT count(*) AS count FROM ${table} WHERE guild_id = $1`,
      [guildId],
    );
    counts[table] = Number(row?.count);
  }
  return counts;
}

describe.skipIf(!sql)("guild data", () => {
  const db = () => sql as SQL;

  test("every table with a guild_id is either deleted or kept on purpose", async () => {
    const rows = await db()<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'guild_id'
      ORDER BY table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual(
      [...GUILD_TABLES, ...KEPT_GUILD_TABLES].sort(),
    );
  });

  test("forget deletes everything of one guild, in every table, and nothing of another", async () => {
    await fill(db(), GONE, 1);
    await fill(db(), STAYS, 2);
    await createDzajcoRepository(db()).set(null, "3000000000000000099", {
      chancePercent: 5,
      cooldownSeconds: 1,
    });
    const before = await countsOf(db(), GONE);
    // The fill must reach every table, or this test would not notice a table forget skips.
    expect(Object.entries(before).filter(([, count]) => count === 0)).toEqual([]);

    const removed = await createGuildDataRepository(db()).forget(GONE);
    expect(removed).toEqual(before);
    expect(Object.values(await countsOf(db(), GONE)).every((count) => count === 0)).toBe(true);
    expect(await countsOf(db(), STAYS)).toEqual(before);
    const [dm] = await db()`SELECT 1 FROM dzajco_channel_config WHERE guild_id IS NULL`;
    expect(dm).toBeDefined();
    // A member's opt-out from this server's DMs outlives the bot's stay.
    const [optOut] = await db()`SELECT 1 FROM scheduled_message_opt_out WHERE guild_id = ${GONE}`;
    expect(optOut).toBeDefined();
  });

  test("forgetting a guild with no data removes nothing", async () => {
    expect(await createGuildDataRepository(db()).forget(GONE)).toEqual({});
  });
});
