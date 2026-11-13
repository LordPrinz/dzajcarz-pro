import type { Logger } from "@dzajcarz/core";
import type { ArchivedMessageInput } from "@dzajcarz/db";
import { type ChannelSummary, MAX_CHANNELS } from "@dzajcarz/web-protocol";
import {
  type Channel,
  ChannelType,
  type Client,
  Events,
  type GuildBasedChannel,
  type Message,
  type PartialMessage,
  RESTJSONErrorCodes,
} from "discord.js";
import type { ChannelHistory } from "../archive-backfill.ts";
import type { ArchivePlace, ArchiveRecorder } from "../archive-recorder.ts";
import { fetchOrNull, hasCode } from "./errors.ts";

/** Postgres refuses U+0000 in text and jsonb, so one such message would fail a whole backfill page. */
const withoutNul = (text: string) => text.replaceAll("\0", "");

/** `value` (plain JSON) with U+0000 removed from every string and key. */
function jsonWithoutNul<T>(value: T): T {
  if (typeof value === "string") return withoutNul(value) as T;
  if (Array.isArray(value)) return value.map(jsonWithoutNul) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [withoutNul(key), jsonWithoutNul(item)]),
    ) as T;
  }
  return value;
}

/** A discord.js message as the archive stores it: the author as they look now, files as links. */
export function toArchivedMessage(message: Message): ArchivedMessageInput {
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    author: jsonWithoutNul({
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.globalName ?? null,
      avatarUrl: message.author.displayAvatarURL(),
      bot: message.author.bot,
    }),
    content: withoutNul(message.content),
    attachments: jsonWithoutNul(
      message.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        contentType: attachment.contentType,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
      })),
    ),
    embeds: jsonWithoutNul(message.embeds.map((embed) => embed.toJSON())),
    replyToId: message.reference?.messageId ?? null,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
  };
}

/**
 * Where a message lives. In a server the channel may be missing from the cache (an uncached thread after a
 * restart), so it is fetched; when it still cannot be found the answer is null and the event is skipped,
 * since an excluded thread parent could not be ruled out.
 */
async function placeOf(
  client: Client,
  guildId: string | null,
  channelId: string,
  known?: Channel | null,
): Promise<ArchivePlace | null> {
  if (guildId === null) return { guildId, channelId, parentId: null };
  const channel =
    known ??
    client.channels.cache.get(channelId) ??
    (await fetchOrNull(client.channels.fetch(channelId)));
  if (!channel) return null;
  if (!channel.isThread()) return { guildId, channelId, parentId: null };
  return channel.parentId ? { guildId, channelId, parentId: channel.parentId } : null;
}

/** Feeds the gateway's message events to the recorder; nothing here throws into other listeners. */
export function attachArchiveRecorder(
  client: Client,
  recorder: ArchiveRecorder,
  logger: Logger,
): void {
  // The recorder never throws, but mapping a message and resolving its channel run before it does.
  const safely =
    <A extends unknown[]>(event: string, handle: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      try {
        await handle(...args);
      } catch (error) {
        logger.error("Archive event handling failed", { event, error });
      }
    };

  const withPlace = async (
    guildId: string | null,
    channelId: string,
    known: Channel | null | undefined,
    record: (place: ArchivePlace) => Promise<void>,
  ) => {
    const place = await placeOf(client, guildId, channelId, known);
    if (place) await record(place);
    else
      logger.debug("Skipped a message event in a channel that could not be found", { channelId });
  };

  client.on(
    Events.MessageCreate,
    safely("create", (message: Message) =>
      withPlace(message.guildId, message.channelId, message.channel, (place) =>
        recorder.created(place, toArchivedMessage(message)),
      ),
    ),
  );
  client.on(
    Events.MessageUpdate,
    safely("update", (_old: unknown, next: Message | PartialMessage) =>
      withPlace(next.guildId, next.channelId, next.channel, (place) =>
        // An uncached message arrives partial; it is fetched only when the archive wants it.
        recorder.updated(place, next.id, async () => {
          if (!next.partial) return toArchivedMessage(next);
          try {
            return toArchivedMessage(await next.fetch());
          } catch (error) {
            if (!hasCode(error, RESTJSONErrorCodes.UnknownMessage)) throw error;
            logger.debug("Skipped an edit of a message that is gone", { messageId: next.id });
            return null;
          }
        }),
      ),
    ),
  );
  client.on(
    Events.MessageDelete,
    safely("delete", (message: Message | PartialMessage) =>
      withPlace(message.guildId, message.channelId, message.channel, (place) =>
        recorder.deleted(place, [message.id], new Date()),
      ),
    ),
  );
  client.on(
    Events.MessageBulkDelete,
    safely("bulk-delete", (messages: ReadonlyMap<string, unknown>, channel: GuildBasedChannel) =>
      withPlace(channel.guildId, channel.id, channel, (place) =>
        recorder.deleted(place, [...messages.keys()], new Date()),
      ),
    ),
  );
}

/** Channel history through discord.js, which waits out rate limits on its own. */
export function createChannelHistory(client: Client): ChannelHistory {
  const textChannel = async (channelId: string) => {
    const channel = await fetchOrNull(client.channels.fetch(channelId));
    return channel?.isTextBased() ? channel : null;
  };
  return {
    async place(channelId) {
      const channel = await textChannel(channelId);
      if (!channel) return null;
      return {
        guildId: "guildId" in channel ? channel.guildId : null,
        channelId: channel.id,
        parentId: channel.isThread() ? channel.parentId : null,
      };
    },
    async page(channelId, before, limit) {
      const channel = await textChannel(channelId);
      if (!channel) return { ok: false, reason: "unknown_channel" };
      try {
        const messages = await channel.messages.fetch({ before, limit, cache: false });
        return { ok: true, messages: [...messages.values()].map(toArchivedMessage) };
      } catch (error) {
        if (
          hasCode(error, RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions)
        ) {
          return { ok: false, reason: "no_access" };
        }
        if (hasCode(error, RESTJSONErrorCodes.UnknownChannel)) {
          return { ok: false, reason: "unknown_channel" };
        }
        throw error;
      }
    },
  };
}

const KINDS: Partial<Record<ChannelType, ChannelSummary["kind"]>> = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
  [ChannelType.PublicThread]: "thread",
  [ChannelType.PrivateThread]: "thread",
  [ChannelType.AnnouncementThread]: "thread",
};

const positionOf = (channel: GuildBasedChannel): number =>
  "rawPosition" in channel ? channel.rawPosition : 0;

/**
 * The channels of a server that can hold messages, from the cache: in the order Discord shows them
 * (categories first, then position), each thread right after its channel. At most `MAX_CHANNELS`, and
 * threads only fill what the channels leave of that.
 */
export function createGuildChannelList(client: Client) {
  return (guildId: string): { channels: ChannelSummary[]; truncated: boolean } | null => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;
    const all = [...guild.channels.cache.values()];
    const categoryPosition = (channel: GuildBasedChannel) => {
      const category = channel.parentId ? guild.channels.cache.get(channel.parentId) : undefined;
      return category ? positionOf(category) : -1;
    };
    const tops = all
      .filter((channel) => !channel.isThread() && KINDS[channel.type] !== undefined)
      .sort(
        (a, b) =>
          categoryPosition(a) - categoryPosition(b) ||
          positionOf(a) - positionOf(b) ||
          a.id.localeCompare(b.id),
      );
    const threads = all.filter((channel) => channel.isThread());
    const threadsOf = (top: GuildBasedChannel) =>
      threads
        .filter((thread) => thread.parentId === top.id)
        .sort((a, b) => a.name.localeCompare(b.name));
    // Channels first: threads only take the room the channels leave.
    const kept = tops.slice(0, MAX_CHANNELS);
    let room = MAX_CHANNELS - kept.length;
    let candidates = tops.length;
    const ordered = kept.flatMap((top) => {
      const own = threadsOf(top);
      candidates += own.length;
      const shown = own.slice(0, room);
      room -= shown.length;
      return [top, ...shown];
    });
    return {
      channels: ordered.map((channel) => ({
        id: channel.id,
        name: channel.name.slice(0, 100),
        kind: KINDS[channel.type] ?? "text",
        parentId: channel.parentId,
      })),
      truncated: ordered.length < candidates,
    };
  };
}
