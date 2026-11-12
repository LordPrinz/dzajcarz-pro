import { z } from "zod";
import { PanelAuthor } from "./messages.ts";
import { Snowflake } from "./snowflake.ts";

/** Discord's limit for the text of one message. */
export const MAX_MESSAGE_LENGTH = 2000;
/** Discord takes at most 10 files per message. */
export const MAX_FILES = 10;
/**
 * The panel's own ceiling for the files of one message, each and all together: they travel through Postgres
 * (`web_upload`), and a boosted server's 50 or 100 MiB would mean holding that much in memory twice.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Discord's upload limit for a bot outside a boosted server, and in DMs. */
export const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;
/** Longest file name kept for an upload. */
export const MAX_FILE_NAME_LENGTH = 200;
/** How many members one `members.search` returns. */
export const MAX_MEMBER_RESULTS = 25;
export const MAX_MEMBER_QUERY_LENGTH = 32;
/** A shorter query would match nearly everyone and cost one Discord call per server for little. */
export const MIN_MEMBER_QUERY_LENGTH = 2;

/**
 * Discord's `nonce` for a sent message (at most 25 characters). The panel keeps one per draft, so a retry of
 * the same draft is not posted twice: with `enforceNonce`, Discord answers a repeated nonce with the message
 * it already created.
 */
export const Nonce = z.string().regex(/^[A-Za-z0-9]{1,25}$/);

/**
 * One emoji: a flag (two regional indicators), a keycap, or pictographs joined by ZWJ, each with an optional
 * variation selector and skin tone, and a closing tag sequence (subdivision flags). Two emoji side by side do
 * not match: a reaction is a single emoji.
 */
const UNICODE_EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*[\u{E0020}-\u{E007E}]*\u{E007F}?)$/u;
const CUSTOM_EMOJI = /^(?:a:)?[A-Za-z0-9_]{2,32}:\d{17,20}$/;

/** A reaction: a unicode emoji, or a custom one as `name:id` (`a:name:id` when animated). */
export const Emoji = z
  .string()
  .max(64)
  .refine(
    (value) => UNICODE_EMOJI.test(value) || CUSTOM_EMOJI.test(value),
    "expected a unicode emoji or name:id",
  );

/** Why the bot did not do what the panel asked; the panel shows each as its own Polish message. */
export const WRITE_REJECTIONS = [
  /** The bot cannot see the channel, or it is not one that holds messages. */
  "unknown_channel",
  "unknown_message",
  "unknown_user",
  "unknown_emoji",
  /** No View Channel or Send Messages (Send Messages in Threads in a thread). */
  "no_send",
  /** No Attach Files. */
  "no_attach",
  /** No Read Message History, needed to reply and to react. */
  "no_history",
  /** No Add Reactions, needed for a new reaction. */
  "no_react",
  /** No Manage Messages, needed to delete someone else's message. */
  "no_manage",
  /** In a DM the bot can delete only its own messages. */
  "dm_not_own",
  /** Discord refused for a reason the bot did not check up front (a locked thread, a missing permission). */
  "forbidden",
  /** Only the bot's own messages can be edited. */
  "not_own",
  /** The user does not take DMs from the bot. */
  "dm_closed",
  /** A file, or all files of the message together, over the target's upload limit. */
  "file_too_large",
  /** An upload is gone (older than the staging time limit) or was sent by another message. */
  "upload_missing",
] as const;
export type WriteRejection = (typeof WRITE_REJECTIONS)[number];

const Rejected = z.object({ status: z.literal("rejected"), reason: z.enum(WRITE_REJECTIONS) });
const Done = z.object({ status: z.literal("ok") });
const DoneOrRejected = z.discriminatedUnion("status", [Done, Rejected]);

const MessageTarget = { channelId: Snowflake, messageId: Snowflake };

export const ChannelInfo = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** null: a DM. */
    guildId: Snowflake.nullable(),
    /** Tells the bot's own messages apart (only those can be edited). */
    botUserId: Snowflake,
    /** Largest file the bot may send here, in bytes, at most `MAX_UPLOAD_BYTES`. */
    uploadLimit: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    /** What the bot's permissions allow here; the bot checks again on every action. */
    can: z.object({
      send: z.boolean(),
      attach: z.boolean(),
      /** Reply and react: both need Read Message History. */
      history: z.boolean(),
      /** Add a new reaction. */
      react: z.boolean(),
      /** Delete other people's messages. */
      manage: z.boolean(),
    }),
  }),
  z.object({ status: z.literal("unknown_channel") }),
]);
export type ChannelInfo = z.infer<typeof ChannelInfo>;

export const MemberResult = PanelAuthor.omit({ bot: true });
export type MemberResult = z.infer<typeof MemberResult>;

const sendFields = {
  content: z.string().max(MAX_MESSAGE_LENGTH),
  replyTo: Snowflake.optional(),
  // ADR 10: no default, so a request that does not say is rejected.
  allowMentions: z.boolean(),
  attachmentIds: z.array(z.uuid()).max(MAX_FILES).optional(),
  nonce: Nonce,
};
const hasTextOrFiles = (request: { content: string; attachmentIds?: string[] | undefined }) =>
  request.content.trim() !== "" || (request.attachmentIds?.length ?? 0) > 0;
const NEEDS_TEXT_OR_FILES = "a message needs text or a file";

/** `message.send` without the channel, which the panel's API takes from the path. */
export const SendMessageBody = z
  .object(sendFields)
  .strict()
  .refine(hasTextOrFiles, NEEDS_TEXT_OR_FILES);

/** The commands that write as the bot (#147). */
export const WRITING_COMMANDS = {
  "channel.info": {
    request: z.object({ channelId: Snowflake }).strict(),
    response: ChannelInfo,
  },
  "message.send": {
    request: z
      .object({ channelId: Snowflake, ...sendFields })
      .strict()
      .refine(hasTextOrFiles, NEEDS_TEXT_OR_FILES),
    response: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), messageId: Snowflake }),
      Rejected,
    ]),
  },
  "message.edit": {
    request: z
      .object({
        ...MessageTarget,
        content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
        allowMentions: z.boolean(),
      })
      .strict(),
    response: DoneOrRejected,
  },
  "message.delete": {
    request: z.object(MessageTarget).strict(),
    response: DoneOrRejected,
  },
  /** Adds the bot's reaction. */
  "reaction.add": {
    request: z.object({ ...MessageTarget, emoji: Emoji }).strict(),
    response: DoneOrRejected,
  },
  /** Removes the bot's own reaction; other people's stay. */
  "reaction.remove": {
    request: z.object({ ...MessageTarget, emoji: Emoji }).strict(),
    response: DoneOrRejected,
  },
  /** Members of one server, or of every server the bot shares (guildId null), whose name starts with `query`. */
  "members.search": {
    request: z
      .object({
        guildId: Snowflake.nullable(),
        query: z.string().trim().min(MIN_MEMBER_QUERY_LENGTH).max(MAX_MEMBER_QUERY_LENGTH),
      })
      .strict(),
    response: z.object({ members: z.array(MemberResult).max(MAX_MEMBER_RESULTS) }),
  },
  /** The DM channel with a user, created when there is none yet. */
  "dm.open": {
    request: z.object({ userId: Snowflake }).strict(),
    response: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), channelId: Snowflake, recipient: MemberResult }),
      Rejected,
    ]),
  },
} as const;
