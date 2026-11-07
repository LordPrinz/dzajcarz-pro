// Row types mirroring migrations/*.sql — update both together.
// Bun.SQL returns columns as-is, so fields use the database's snake_case names.

export interface GuildSettingsRow {
  guild_id: string;
  /** null: the guild uses the bot's default prefix. */
  prefix: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ModuleDisabledRow {
  guild_id: string;
  module: string;
  /** '' = the whole guild. */
  channel_id: string;
  created_at: Date;
}

export interface WelcomeConfigRow {
  guild_id: string;
  channel_id: string;
  template: string;
  created_at: Date;
  updated_at: Date;
}
