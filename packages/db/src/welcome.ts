import type { SQL } from "bun";
import type { WelcomeConfigRow } from "./types.ts";

export interface WelcomeConfig {
  channelId: string;
  template: string;
}

export interface WelcomeRepository {
  get(guildId: string): Promise<WelcomeConfig | null>;
  /** Insert or replace the guild's config. */
  set(guildId: string, config: WelcomeConfig): Promise<void>;
  /** False when the guild had no config. */
  delete(guildId: string): Promise<boolean>;
}

export function createWelcomeRepository(sql: SQL): WelcomeRepository {
  return {
    async get(guildId) {
      const [row] = await sql<WelcomeConfigRow[]>`
        SELECT * FROM welcome_config WHERE guild_id = ${guildId}
      `;
      return row ? { channelId: row.channel_id, template: row.template } : null;
    },

    async set(guildId, { channelId, template }) {
      await sql`
        INSERT INTO welcome_config (guild_id, channel_id, template)
        VALUES (${guildId}, ${channelId}, ${template})
        ON CONFLICT (guild_id) DO UPDATE
          SET channel_id = EXCLUDED.channel_id, template = EXCLUDED.template, updated_at = now()
      `;
    },

    async delete(guildId) {
      const deleted = await sql<WelcomeConfigRow[]>`
        DELETE FROM welcome_config WHERE guild_id = ${guildId} RETURNING *
      `;
      return deleted.length > 0;
    },
  };
}
