import type { SQL } from "bun";
import type { ModuleDisabledRow } from "./types.ts";

export interface DisabledModule {
  module: string;
  /** null: off in the whole guild. */
  channelId: string | null;
}

export interface ModuleToggleRepository {
  listDisabled(guildId: string): Promise<DisabledModule[]>;
  /** Idempotent. `channelId` null turns the module off for the whole guild. */
  disable(guildId: string, module: string, channelId: string | null): Promise<void>;
  /** Removes exactly the matching entry; false when there was none. */
  enable(guildId: string, module: string, channelId: string | null): Promise<boolean>;
}

/** The table stores "whole guild" as an empty channel id. */
const WHOLE_GUILD = "";

export function createModuleToggleRepository(sql: SQL): ModuleToggleRepository {
  return {
    async listDisabled(guildId) {
      const rows = await sql<ModuleDisabledRow[]>`
        SELECT * FROM module_disabled WHERE guild_id = ${guildId} ORDER BY module, channel_id
      `;
      return rows.map((row) => ({
        module: row.module,
        channelId: row.channel_id === WHOLE_GUILD ? null : row.channel_id,
      }));
    },

    async disable(guildId, module, channelId) {
      await sql`
        INSERT INTO module_disabled (guild_id, module, channel_id)
        VALUES (${guildId}, ${module}, ${channelId ?? WHOLE_GUILD})
        ON CONFLICT DO NOTHING
      `;
    },

    async enable(guildId, module, channelId) {
      const deleted = await sql<ModuleDisabledRow[]>`
        DELETE FROM module_disabled
        WHERE guild_id = ${guildId} AND module = ${module} AND channel_id = ${channelId ?? WHOLE_GUILD}
        RETURNING *
      `;
      return deleted.length > 0;
    },
  };
}
