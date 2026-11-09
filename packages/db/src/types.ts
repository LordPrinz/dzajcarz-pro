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

export interface PartyAreaRow {
  join_channel_id: string;
  guild_id: string;
  category_id: string;
  name_template: string;
  command_channel: boolean;
  panel_message_id: string | null;
  created_at: Date;
}

export interface PartyChannelRow {
  channel_id: string;
  guild_id: string;
  owner_id: string;
  area_join_channel_id: string;
  created_at: Date;
}

export interface ScheduledSongConfigRow {
  guild_id: string;
  song: string;
  updated_at: Date;
}

export interface ScheduledSongExclusionRow {
  guild_id: string;
  channel_id: string;
  created_at: Date;
}

export interface ScheduledMessageRow {
  /** bigint comes back from Bun.SQL as a string. */
  id: string;
  guild_id: string;
  time_of_day: string;
  content: string;
  channel_id: string | null;
  user_id: string | null;
  created_by: string;
  created_at: Date;
}

export interface ScheduledMessageOptOutRow {
  user_id: string;
  guild_id: string | null;
  created_at: Date;
}
