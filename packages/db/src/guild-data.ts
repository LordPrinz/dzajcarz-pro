import type { SQL } from "bun";

/**
 * Every table with a `guild_id`, children before parents, except `KEPT_GUILD_TABLES`. guild-data.test.ts
 * compares both lists with the schema, so a new table that keeps per-server data fails the test until it is
 * listed in one of them.
 */
export const GUILD_TABLES = [
  "party_channel",
  "party_area",
  "scheduled_message",
  "scheduled_song_exclusion",
  "scheduled_song_config",
  "dzajco_channel_config",
  "moderation_action",
  "module_disabled",
  "welcome_config",
  "guild_settings",
  "archive_settings",
] as const;

/**
 * Tables with a `guild_id` that survive the bot leaving. An opt-out from a server's scheduled DMs is the
 * member's own choice, not the server's data; deleting it would let that server DM them again after
 * re-adding the bot. `web_audit` is the owner's record of what the web panel did, not the server's data.
 * `archived_message` is the owner's archive, kept without a retention limit; the archive settings go, so a
 * server that adds the bot again starts with the archive off.
 */
export const KEPT_GUILD_TABLES = [
  "scheduled_message_opt_out",
  "web_audit",
  "archived_message",
] as const;

export type GuildTable = (typeof GUILD_TABLES)[number];

export interface GuildDataRepository {
  /**
   * Deletes everything stored for the guild, in one transaction; returns the rows removed per table (tables
   * with none left out). DM rows (guild_id NULL) are not touched.
   */
  forget(guildId: string): Promise<Partial<Record<GuildTable, number>>>;
}

type Delete = (tx: SQL, guildId: string) => Promise<unknown[]>;

/** One plain statement per table: Bun.SQL takes no table names as parameters, and nothing is pasted in. */
const DELETES: Record<GuildTable, Delete> = {
  party_channel: (tx, guildId) =>
    tx`DELETE FROM party_channel WHERE guild_id = ${guildId} RETURNING 1`,
  party_area: (tx, guildId) => tx`DELETE FROM party_area WHERE guild_id = ${guildId} RETURNING 1`,
  scheduled_message: (tx, guildId) =>
    tx`DELETE FROM scheduled_message WHERE guild_id = ${guildId} RETURNING 1`,
  scheduled_song_exclusion: (tx, guildId) =>
    tx`DELETE FROM scheduled_song_exclusion WHERE guild_id = ${guildId} RETURNING 1`,
  scheduled_song_config: (tx, guildId) =>
    tx`DELETE FROM scheduled_song_config WHERE guild_id = ${guildId} RETURNING 1`,
  dzajco_channel_config: (tx, guildId) =>
    tx`DELETE FROM dzajco_channel_config WHERE guild_id = ${guildId} RETURNING 1`,
  moderation_action: (tx, guildId) =>
    tx`DELETE FROM moderation_action WHERE guild_id = ${guildId} RETURNING 1`,
  module_disabled: (tx, guildId) =>
    tx`DELETE FROM module_disabled WHERE guild_id = ${guildId} RETURNING 1`,
  welcome_config: (tx, guildId) =>
    tx`DELETE FROM welcome_config WHERE guild_id = ${guildId} RETURNING 1`,
  guild_settings: (tx, guildId) =>
    tx`DELETE FROM guild_settings WHERE guild_id = ${guildId} RETURNING 1`,
  archive_settings: (tx, guildId) =>
    tx`DELETE FROM archive_settings WHERE guild_id = ${guildId} RETURNING 1`,
};

export function createGuildDataRepository(sql: SQL): GuildDataRepository {
  return {
    forget(guildId) {
      return sql.begin(async (tx) => {
        const removed: Partial<Record<GuildTable, number>> = {};
        for (const table of GUILD_TABLES) {
          const rows = await DELETES[table](tx, guildId);
          if (rows.length > 0) removed[table] = rows.length;
        }
        return removed;
      });
    },
  };
}
