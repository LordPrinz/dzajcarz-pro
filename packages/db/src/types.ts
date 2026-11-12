// Row types mirroring migrations/*.sql — update both together.
// Bun.SQL returns columns as-is, so fields use the database's snake_case names.

export interface GuildSettingsRow {
  guild_id: string;
  /** null: the guild uses the bot's default prefix. */
  prefix: string | null;
  /** IANA zone; null: the bot's default zone. */
  time_zone: string | null;
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

export interface DzajcoChannelConfigRow {
  /** null: a DM with the bot. */
  guild_id: string | null;
  channel_id: string;
  chance_percent: number;
  cooldown_seconds: number;
  updated_at: Date;
}

export interface ModerationActionRow {
  /** bigint; Bun.SQL hands it over as a string. */
  id: string;
  guild_id: string;
  action: "ban" | "kick" | "timeout" | "untimeout" | "warn" | "purge";
  moderator_id: string;
  target_id: string | null;
  channel_id: string | null;
  reason: string | null;
  /** bigint; Bun.SQL hands it over as a string. */
  duration_ms: string | null;
  message_count: number | null;
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
  last_sent_date: Date | null;
}

export interface ScheduledMessageOptOutRow {
  user_id: string;
  guild_id: string | null;
  created_at: Date;
}

/** `pending` while the action runs; one of the others once it finished. */
export type WebAuditOutcome = "pending" | "ok" | "failed" | "unavailable" | "timeout" | "rejected";

export interface WebAuditRow {
  /** bigint comes back from Bun.SQL as a string. */
  id: string;
  actor: string | null;
  action: string;
  guild_id: string | null;
  channel_id: string | null;
  payload: unknown;
  outcome: WebAuditOutcome;
  error: string | null;
  created_at: Date;
}

export interface ArchiveSettingsRow {
  guild_id: string;
  enabled: boolean;
  excluded_channel_ids: string[];
  updated_at: Date;
}

export interface ArchivedMessageRow {
  message_id: string;
  /** null: a DM. */
  guild_id: string | null;
  channel_id: string;
  author_id: string;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  author_bot: boolean;
  content: string;
  attachments: unknown;
  embeds: unknown;
  reply_to_id: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  archived_at: Date;
}

export interface ArchivedMessageVersionRow {
  /** bigint comes back from Bun.SQL as a string. */
  id: string;
  message_id: string;
  content: string;
  attachments: unknown;
  embeds: unknown;
  /** When this version was written; null: the original message. */
  edited_at: Date | null;
  replaced_at: Date;
}
