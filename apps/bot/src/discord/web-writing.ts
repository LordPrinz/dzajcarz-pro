import type { Logger } from "@dzajcarz/core";
import type { StagedUpload, UploadStore } from "@dzajcarz/db";
import {
  type CommandResponse,
  DEFAULT_UPLOAD_LIMIT,
  MAX_MEMBER_RESULTS,
  MAX_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  type MemberResult,
  type WriteRejection,
} from "@dzajcarz/web-protocol";
import {
  type Client,
  GuildPremiumTier,
  type Message,
  type MessageMentionOptions,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
  type SendableChannels,
  type User,
} from "discord.js";
import type { WritingControl } from "../web-bridge.ts";
import { fetchOrNull, hasCode } from "./errors.ts";
import { NO_MENTIONS } from "./reply.ts";
import { cdnAvatar } from "./web-reading.ts";

/**
 * The one place that turns the panel's mention switch into `allowedMentions` (ADR 10). On: users and roles,
 * never `everyone` (so `@everyone` and `@here` stay text), and a reply does not ping its author. Off: nothing.
 */
export function panelMentions(allowMentions: boolean): MessageMentionOptions {
  return allowMentions ? { parse: ["users", "roles"], repliedUser: false } : NO_MENTIONS;
}

const MIB = 1024 * 1024;
const TIER_LIMITS: Record<GuildPremiumTier, number> = {
  [GuildPremiumTier.None]: DEFAULT_UPLOAD_LIMIT,
  [GuildPremiumTier.Tier1]: DEFAULT_UPLOAD_LIMIT,
  [GuildPremiumTier.Tier2]: 50 * MIB,
  [GuildPremiumTier.Tier3]: 100 * MIB,
};

/** Largest file the bot may send: the server's boost tier decides, a DM has the default, the panel caps both. */
export function uploadLimit(guild: { premiumTier: GuildPremiumTier } | null): number {
  const limit = guild
    ? (TIER_LIMITS[guild.premiumTier] ?? DEFAULT_UPLOAD_LIMIT)
    : DEFAULT_UPLOAD_LIMIT;
  return Math.min(limit, MAX_UPLOAD_BYTES);
}

export interface Rights {
  send: boolean;
  attach: boolean;
  history: boolean;
  /** Add Reactions: a new reaction needs it on top of Read Message History. */
  react: boolean;
  manage: boolean;
}

/** What the bot may do in a channel. In a DM it may do everything but delete the other side's messages. */
export function rightsIn(channel: SendableChannels, botUserId: string): Rights {
  if (channel.isDMBased()) {
    return { send: true, attach: true, history: true, react: true, manage: false };
  }
  const permissions = channel.permissionsFor(botUserId);
  const has = (flag: bigint) => permissions?.has(flag) === true;
  const view = has(PermissionFlagsBits.ViewChannel);
  const send =
    view &&
    has(
      channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages,
    );
  return {
    send,
    attach: send && has(PermissionFlagsBits.AttachFiles),
    history: view && has(PermissionFlagsBits.ReadMessageHistory),
    react: view && has(PermissionFlagsBits.AddReactions),
    manage: view && has(PermissionFlagsBits.ManageMessages),
  };
}

type Rejected = { status: "rejected"; reason: WriteRejection };
const rejected = (reason: WriteRejection): Rejected => ({ status: "rejected", reason });

/** Discord's refusals the panel can explain; anything else is a failure. */
const REJECTIONS: [number[], WriteRejection][] = [
  [
    [
      RESTJSONErrorCodes.MissingAccess,
      RESTJSONErrorCodes.MissingPermissions,
      RESTJSONErrorCodes.ThreadLocked,
      RESTJSONErrorCodes.ReactionWasBlocked,
    ],
    "forbidden",
  ],
  [[RESTJSONErrorCodes.UnknownChannel], "unknown_channel"],
  [[RESTJSONErrorCodes.UnknownMessage], "unknown_message"],
  [[RESTJSONErrorCodes.UnknownEmoji], "unknown_emoji"],
  [[RESTJSONErrorCodes.UnknownUser], "unknown_user"],
  [
    [
      RESTJSONErrorCodes.CannotSendMessagesToThisUser,
      RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds,
    ],
    "dm_closed",
  ],
  [[RESTJSONErrorCodes.RequestEntityTooLarge], "file_too_large"],
];

/** Discord's answer to a reply whose message is gone: an invalid form body naming `message_reference`. */
const isLostReply = (error: unknown): boolean =>
  hasCode(error, RESTJSONErrorCodes.InvalidFormBodyOrContentType) &&
  JSON.stringify((error as { rawError?: { errors?: unknown } }).rawError?.errors ?? {}).includes(
    "message_reference",
  );

/** Runs a Discord call; a refusal the panel can explain becomes a rejection, anything else is thrown on. */
async function attempt<T>(call: () => Promise<T>): Promise<T | Rejected> {
  try {
    return await call();
  } catch (error) {
    if (isLostReply(error)) return rejected("unknown_message");
    const match = REJECTIONS.find(([codes]) => hasCode(error, ...codes));
    if (match) return rejected(match[1]);
    throw error;
  }
}

const isRejected = (value: unknown): value is Rejected =>
  typeof value === "object" &&
  value !== null &&
  (value as { status?: unknown }).status === "rejected";

/** A channel the bot could send to, or null when it cannot see it or it holds no messages. */
async function sendable(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = await fetchOrNull(client.channels.fetch(channelId));
  return channel?.isSendable() ? channel : null;
}

const guildOf = (channel: SendableChannels) => (channel.isDMBased() ? null : channel.guild);

/** The path segment Discord expects for a reaction: `name:id` as it is, a unicode emoji URL-encoded. */
export const reactionIdentifier = (emoji: string): string =>
  /:\d{17,20}$/.test(emoji) ? emoji : encodeURIComponent(emoji);

/** Whether the message already carries this emoji (from anyone): only a new one needs Add Reactions. */
const hasReaction = (message: Message, emoji: string): boolean => {
  const custom = /:(\d{17,20})$/.exec(emoji)?.[1];
  return message.reactions.cache.some((reaction) =>
    custom ? reaction.emoji.id === custom : reaction.emoji.name === emoji,
  );
};

const memberResult = (user: User): MemberResult => ({
  id: user.id,
  username: user.username.slice(0, MAX_NAME_LENGTH),
  displayName: user.globalName?.slice(0, MAX_NAME_LENGTH) ?? null,
  avatarUrl: cdnAvatar(user),
});

/** Servers searched at once by `members.search`. */
export const SEARCH_CONCURRENCY = 3;

export interface WritingDeps {
  client: Client;
  uploads: Pick<UploadStore, "sizes" | "claim">;
  logger: Logger;
}

/**
 * The panel's write commands (#147). Every one checks the bot's permissions itself (the panel's view of them
 * may be stale) and answers a refusal as `{ status: "rejected", reason }`, so nothing is half done.
 */
export function createWriting({ client, uploads, logger }: WritingDeps): WritingControl {
  // Sends with files go one after another, so concurrent panel sends do not hammer Discord or the pool.
  let uploadQueue: Promise<unknown> = Promise.resolve();
  const inUploadQueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = uploadQueue.then(task, task);
    uploadQueue = run.catch(() => {});
    return run;
  };

  /** The channel and the bot's rights in it, or why there is nothing to do. */
  async function target(
    channelId: string,
  ): Promise<{ channel: SendableChannels; botUserId: string; can: Rights } | Rejected> {
    const botUserId = client.user?.id;
    const channel = botUserId ? await sendable(client, channelId) : null;
    if (!channel || !botUserId) return rejected("unknown_channel");
    return { channel, botUserId, can: rightsIn(channel, botUserId) };
  }

  async function fetchMessage(channel: SendableChannels, messageId: string) {
    return attempt(() => channel.messages.fetch({ message: messageId, cache: false }));
  }

  return {
    async "channel.info"({ channelId }) {
      const found = await target(channelId);
      if (isRejected(found)) return { status: "unknown_channel" };
      const guild = guildOf(found.channel);
      return {
        status: "ok",
        guildId: guild?.id ?? null,
        botUserId: found.botUserId,
        uploadLimit: uploadLimit(guild),
        can: found.can,
      };
    },

    async "message.send"({
      channelId,
      content,
      replyTo,
      allowMentions,
      attachmentIds = [],
      nonce,
    }) {
      const found = await target(channelId);
      if (isRejected(found)) return found;
      const { channel, can } = found;
      if (!can.send) return rejected("no_send");
      if (replyTo && !can.history) return rejected("no_history");
      if (attachmentIds.length > 0 && !can.attach) return rejected("no_attach");
      const ids = [...new Set(attachmentIds)];
      // Sizes first, without the bytes: a file over the limit is refused before anything is loaded.
      const sizes = await uploads.sizes(ids);
      if (sizes.length !== ids.length) return rejected("upload_missing");
      // Conservative: all files together must fit the limit of one file.
      const total = sizes.reduce((sum, file) => sum + file.size, 0);
      if (total > uploadLimit(guildOf(channel))) return rejected("file_too_large");
      const post = (files: StagedUpload[]) =>
        attempt<{ id: string }>(() =>
          channel.send({
            content: content.trim() === "" ? undefined : content,
            files: files.map((file) => ({ attachment: file.data, name: file.name })),
            reply: replyTo ? { messageReference: replyTo, failIfNotExists: true } : undefined,
            allowedMentions: panelMentions(allowMentions),
            // A retried send of the same draft (another bot instance, a panel retry after a timeout) is not
            // posted twice: Discord answers a nonce it saw a moment ago with the message it already created.
            nonce,
            enforceNonce: true,
          }),
        );
      let sent: { id: string } | Rejected;
      if (ids.length === 0) {
        sent = await post([]);
      } else {
        // The files stay leased while they are sent and keep the nonce afterwards, so a later retry of this
        // message gets them again (and Discord deduplicates it) while another message does not.
        const claimed = await inUploadQueue(() =>
          uploads.claim(ids, nonce, post, (result) => !isRejected(result)),
        );
        if (claimed.status === "busy") return rejected("upload_busy");
        if (claimed.status !== "ok") return rejected("upload_missing");
        sent = claimed.value;
      }
      if (isRejected(sent)) return sent;
      return { status: "ok", messageId: sent.id };
    },

    async "message.edit"({ channelId, messageId, content, allowMentions }) {
      const found = await target(channelId);
      if (isRejected(found)) return found;
      const message = await fetchMessage(found.channel, messageId);
      if (isRejected(message)) return message;
      if (message.author.id !== found.botUserId) return rejected("not_own");
      const edited = await attempt(() =>
        message.edit({ content, allowedMentions: panelMentions(allowMentions) }),
      );
      return isRejected(edited) ? edited : { status: "ok" };
    },

    async "message.delete"({ channelId, messageId }) {
      const found = await target(channelId);
      if (isRejected(found)) return found;
      const message = await fetchMessage(found.channel, messageId);
      if (isRejected(message)) return message;
      if (message.author.id !== found.botUserId) {
        if (found.channel.isDMBased()) return rejected("dm_not_own");
        if (!found.can.manage) return rejected("no_manage");
      }
      const deleted = await attempt(() => message.delete());
      return isRejected(deleted) ? deleted : { status: "ok" };
    },

    async "reaction.add"({ channelId, messageId, emoji }) {
      const found = await target(channelId);
      if (isRejected(found)) return found;
      if (!found.can.history) return rejected("no_history");
      if (!found.can.react) {
        const message = await fetchMessage(found.channel, messageId);
        if (isRejected(message)) return message;
        if (!hasReaction(message, emoji)) return rejected("no_react");
      }
      const done = await attempt(() =>
        client.rest.put(
          Routes.channelMessageOwnReaction(channelId, messageId, reactionIdentifier(emoji)),
        ),
      );
      return isRejected(done) ? done : { status: "ok" };
    },

    async "reaction.remove"({ channelId, messageId, emoji }) {
      const found = await target(channelId);
      if (isRejected(found)) return found;
      const done = await attempt(() =>
        client.rest.delete(
          Routes.channelMessageOwnReaction(channelId, messageId, reactionIdentifier(emoji)),
        ),
      );
      return isRejected(done) ? done : { status: "ok" };
    },

    async "members.search"({ guildId, query }) {
      const guilds = guildId
        ? [client.guilds.cache.get(guildId)].filter((guild) => guild !== undefined)
        : [...client.guilds.cache.values()];
      const members = new Map<string, MemberResult>();
      // A few servers at a time, and no more once the list is full: one search is one Discord call per
      // server, under that server's rate limit.
      for (
        let start = 0;
        start < guilds.length && members.size < MAX_MEMBER_RESULTS;
        start += SEARCH_CONCURRENCY
      ) {
        const found = await Promise.all(
          guilds.slice(start, start + SEARCH_CONCURRENCY).map((guild) =>
            guild.members
              .search({ query, limit: MAX_MEMBER_RESULTS, cache: false })
              .catch((error) => {
                logger.warn("Member search failed", { guildId: guild.id, error });
                return null;
              }),
          ),
        );
        for (const page of found) {
          for (const member of page?.values() ?? []) {
            // The bot cannot write to another bot.
            if (!member.user.bot && !members.has(member.id)) {
              members.set(member.id, memberResult(member.user));
            }
          }
        }
      }
      return { members: [...members.values()].slice(0, MAX_MEMBER_RESULTS) };
    },

    async "dm.open"({ userId }): Promise<CommandResponse<"dm.open">> {
      const user = await attempt(() => client.users.fetch(userId));
      if (isRejected(user)) return user;
      if (user.bot || user.id === client.user?.id) return rejected("dm_closed");
      const channel = await attempt(() => user.createDM());
      if (isRejected(channel)) return channel;
      return { status: "ok", channelId: channel.id, recipient: memberResult(user) };
    },
  };
}
