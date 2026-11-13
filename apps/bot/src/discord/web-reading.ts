import type { Logger } from "@dzajcarz/core";
import {
  type ChannelMessages,
  type CommandRequest,
  type CommandResponse,
  type EventName,
  type EventPayload,
  fitPage,
  MAX_DELETED_IDS,
  MAX_DM_CHANNELS,
  MAX_NAME_LENGTH,
  MAX_RESOLVED_NAME_LENGTH,
  mentionIds,
  mentionTexts,
  type PanelMessage,
  type Resolved,
  toPanelMessage,
} from "@dzajcarz/web-protocol";
import {
  ChannelType,
  type Client,
  type DMChannel,
  Events,
  type GuildBasedChannel,
  type Message,
  type PartialMessage,
  RESTJSONErrorCodes,
  type User,
} from "discord.js";
import { toArchivedMessage } from "./archive.ts";
import { fetchOrNull, hasCode } from "./errors.ts";

/** A discord.js message in the panel's shape. */
export const toPanel = (message: Message): PanelMessage =>
  toPanelMessage(toArchivedMessage(message));

const cut = (name: string) => name.slice(0, MAX_RESOLVED_NAME_LENGTH);

/** Avatars the panel shows must be short links on Discord's CDN (the schema checks it too). */
export const cdnAvatar = (user: User): string | null => {
  const url = user.displayAvatarURL();
  return url.startsWith("https://cdn.discordapp.com/") && url.length <= 256 ? url : null;
};

export type ResolveNames = (
  request: CommandRequest<"names.resolve">,
) => Promise<CommandResponse<"names.resolve">>;

/** Names from the bot's caches only: nothing here calls Discord, so an unknown id is simply left out. */
export function createNameResolver(client: Client): ResolveNames {
  return async ({ guildId, users, roles, channels }) => {
    const guild = guildId ? client.guilds.cache.get(guildId) : undefined;
    const resolved: Resolved = { users: {}, roles: {}, channels: {} };
    for (const id of users) {
      const member = guild?.members.cache.get(id);
      const user = member?.user ?? client.users.cache.get(id);
      const name = member?.displayName ?? user?.globalName ?? user?.username;
      if (name) resolved.users[id] = cut(name);
    }
    for (const id of roles) {
      const role = guild?.roles.cache.get(id);
      if (role) {
        const color = role.colors.primaryColor;
        resolved.roles[id] = { name: cut(role.name), color: color === 0 ? null : color };
      }
    }
    for (const id of channels) {
      const channel = client.channels.cache.get(id);
      if (channel && "name" in channel && typeof channel.name === "string") {
        resolved.channels[id] = cut(channel.name);
      }
    }
    return resolved;
  };
}

/** The names a set of messages mentions. */
const namesFor = (resolve: ResolveNames, guildId: string | null, messages: PanelMessage[]) =>
  resolve({ guildId, ...mentionIds(messages.flatMap(mentionTexts)) });

/**
 * `channel.messages`: one page of a channel read from Discord, never stored. The page is cut to fit in one
 * protocol message; `hasMore` is then true, and the next page starts before the oldest message kept.
 */
export function createChannelReader(client: Client, resolve: ResolveNames) {
  return async ({
    channelId,
    before,
    limit,
  }: CommandRequest<"channel.messages">): Promise<ChannelMessages> => {
    const channel = await fetchOrNull(client.channels.fetch(channelId));
    if (!channel?.isTextBased()) return { status: "unknown_channel" };
    let fetched: Message[];
    try {
      const page = await channel.messages.fetch({ before, limit, cache: false });
      fetched = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    } catch (error) {
      if (hasCode(error, RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions)) {
        return { status: "no_access" };
      }
      if (hasCode(error, RESTJSONErrorCodes.UnknownChannel)) return { status: "unknown_channel" };
      throw error;
    }
    const messages = fetched.map(toPanel);
    const guildId = "guildId" in channel ? channel.guildId : null;
    const fitted = fitPage(messages, await namesFor(resolve, guildId, messages));
    return {
      status: "ok",
      messages: fitted.messages,
      resolved: fitted.resolved,
      hasMore: fitted.dropped > 0 || fetched.length === limit,
    };
  };
}

const newestFirst = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return BigInt(b) > BigInt(a) ? 1 : -1;
};

/**
 * `dms.list`: the DM channels discord.js has cached. Discord gives a bot no list of its DMs, so after a
 * restart this holds only the conversations active since; the panel adds the archived ones.
 */
export function createDmList(client: Client) {
  return async (): Promise<CommandResponse<"dms.list">> => {
    const dms = [...client.channels.cache.values()]
      .filter((channel): channel is DMChannel => channel.type === ChannelType.DM)
      .map((channel) => ({ channel, last: channel.lastMessageId ?? null }))
      .sort((a, b) => newestFirst(a.last, b.last));
    return {
      channels: dms.slice(0, MAX_DM_CHANNELS).map(({ channel, last }) => {
        const user = channel.recipient;
        return {
          channelId: channel.id,
          recipient: user
            ? {
                id: user.id,
                username: user.username.slice(0, MAX_NAME_LENGTH),
                displayName: user.globalName?.slice(0, MAX_NAME_LENGTH) ?? null,
                avatarUrl: cdnAvatar(user),
              }
            : null,
          lastMessageId: last,
        };
      }),
      truncated: dms.length > MAX_DM_CHANNELS,
    };
  };
}

export type PublishEvent = <N extends EventName>(
  name: N,
  payload: EventPayload<N>,
) => Promise<void>;

/**
 * Publishes every message the bot sees, archived or not, for the panel's live view (ADR 9). Nothing is
 * stored: a panel that is not listening misses the events. Failures are logged and go no further.
 */
export function attachMessageEvents(
  client: Client,
  { publish, resolve, logger }: { publish: PublishEvent; resolve: ResolveNames; logger: Logger },
): void {
  const safely =
    <A extends unknown[]>(event: string, handle: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      try {
        await handle(...args);
      } catch (error) {
        logger.error("Publishing a message event failed", { event, error });
      }
    };

  const publishMessage = async (
    name: "message.created" | "message.updated",
    message: Message,
  ): Promise<void> => {
    const panel = toPanel(message);
    const fitted = fitPage([panel], await namesFor(resolve, message.guildId, [panel]));
    const [kept] = fitted.messages;
    if (kept) await publish(name, { message: kept, resolved: fitted.resolved });
  };

  client.on(
    Events.MessageCreate,
    safely("create", (message: Message) => publishMessage("message.created", message)),
  );
  client.on(
    Events.MessageUpdate,
    // An edit of an uncached message arrives partial. It is not fetched here: the archive already fetches it
    // when it wants it, and a second call per edit is not worth a live update. The panel reloads to see it.
    safely("update", async (_old: unknown, next: Message | PartialMessage) => {
      if (!next.partial) await publishMessage("message.updated", next);
    }),
  );
  client.on(
    Events.MessageDelete,
    safely("delete", (message: Message | PartialMessage) =>
      publish("message.deleted", {
        guildId: message.guildId,
        channelId: message.channelId,
        ids: [message.id],
      }),
    ),
  );
  client.on(
    Events.MessageBulkDelete,
    safely(
      "bulk-delete",
      async (messages: ReadonlyMap<string, unknown>, channel: GuildBasedChannel) => {
        const ids = [...messages.keys()];
        for (let start = 0; start < ids.length; start += MAX_DELETED_IDS) {
          await publish("message.deleted", {
            guildId: channel.guildId,
            channelId: channel.id,
            ids: ids.slice(start, start + MAX_DELETED_IDS),
          });
        }
      },
    ),
  );
}
