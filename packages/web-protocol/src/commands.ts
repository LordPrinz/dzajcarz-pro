import { z } from "zod";

export const Snowflake = z.string().regex(/^\d{17,20}$/, "expected a Discord id (17-20 digits)");

export const GuildSummary = z.object({
  id: Snowflake,
  name: z.string(),
  // Rendered as an <img> in the panel, so only Discord's CDN (which the CSP allows too).
  iconUrl: z
    .url({ protocol: /^https$/, hostname: /^cdn\.discordapp\.com$/ })
    .max(512)
    .nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type GuildSummary = z.infer<typeof GuildSummary>;

export const CHANNEL_KINDS = [
  "text",
  "announcement",
  "voice",
  "stage",
  "forum",
  "media",
  "thread",
] as const;

export const ChannelSummary = z.object({
  id: Snowflake,
  name: z.string().max(100),
  kind: z.enum(CHANNEL_KINDS),
  /** The category, or for a thread the channel it belongs to. */
  parentId: Snowflake.nullable(),
});
export type ChannelSummary = z.infer<typeof ChannelSummary>;

/** At most this many channels in one `guilds.channels` reply: 150 names of 100 three-byte characters still fit in 64 KB. */
export const MAX_CHANNELS = 150;
/** At most this many excluded channels per server. */
export const MAX_EXCLUDED_CHANNELS = 500;

export const GuildArchiveSettings = z.object({
  guildId: Snowflake,
  enabled: z.boolean(),
  excludedChannelIds: z.array(Snowflake).max(MAX_EXCLUDED_CHANNELS),
});
export type GuildArchiveSettings = z.infer<typeof GuildArchiveSettings>;

export const BackfillResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** Messages Discord returned. */
    fetched: z.number().int().nonnegative(),
    /** Of those, the ones the archive did not have yet. */
    stored: z.number().int().nonnegative(),
    /** The oldest message reached, where the next call continues; null when the channel is empty. */
    oldestId: Snowflake.nullable(),
    /** Discord has nothing older. */
    done: z.boolean(),
  }),
  // The channel's server is not archived, or the channel is excluded.
  z.object({ status: z.literal("not_archived") }),
  // The bot cannot see the channel, or it holds no messages.
  z.object({ status: z.literal("unknown_channel") }),
  // The bot may see the channel but not read its history.
  z.object({ status: z.literal("no_access") }),
]);
export type BackfillResult = z.infer<typeof BackfillResult>;

/** Every command the panel can send: a schema for the request and one for the response. */
export const COMMANDS = {
  "guilds.list": {
    request: z.object({}).strict(),
    response: z.array(GuildSummary),
  },
  /** The channels of one server that can hold messages, from the bot's cache; null: the bot is not in it. */
  "guilds.channels": {
    request: z.object({ guildId: Snowflake }).strict(),
    response: z
      .object({ channels: z.array(ChannelSummary).max(MAX_CHANNELS), truncated: z.boolean() })
      .nullable(),
  },
  "archive.guild.set": {
    request: GuildArchiveSettings.strict(),
    response: GuildArchiveSettings,
  },
  "archive.dm.set": {
    request: z.object({ enabled: z.boolean() }).strict(),
    response: z.object({ enabled: z.boolean() }),
  },
  /** Stores older messages of one channel; `before` defaults to the oldest one already archived. */
  "archive.backfill": {
    request: z.object({ channelId: Snowflake, before: Snowflake.optional() }).strict(),
    response: BackfillResult,
  },
} as const;

export type CommandName = keyof typeof COMMANDS;
export type CommandRequest<N extends CommandName> = z.infer<(typeof COMMANDS)[N]["request"]>;
export type CommandResponse<N extends CommandName> = z.infer<(typeof COMMANDS)[N]["response"]>;

export const isCommandName = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);
