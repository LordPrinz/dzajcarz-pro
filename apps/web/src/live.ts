import type { BotClient, BotEvent, EventPayload } from "@dzajcarz/web-protocol";
import { isBotOnline, Snowflake } from "@dzajcarz/web-protocol";
import { z } from "zod";

/** The WebSocket topic every socket is on: the bot's status, and whether music can play at all. */
export const BOT_TOPIC = "bot";

/** The topic of one channel's message events; a socket joins it by sending `subscribe`. */
export const channelTopic = (channelId: string): string => `channel:${channelId}`;

/** The topic of one server's music player; a socket joins it by sending `subscribe` with `musicGuildId`. */
export const musicTopic = (guildId: string): string => `music:${guildId}`;

/** A socket watches at most this many channels and players at once; the panel shows one of each. */
export const MAX_TOPICS_PER_SOCKET = 10;

/** What the panel sends over the socket and `/api/status` derives from. */
export interface StatusMessage {
  event: "bot.status";
  online: boolean;
  /** Null until the first heartbeat arrives. */
  payload: EventPayload<"bot.status"> | null;
  /** When the last heartbeat arrived, epoch ms. */
  lastSeen: number | null;
}

export interface LiveState {
  record(payload: EventPayload<"bot.status">): void;
  status(): StatusMessage;
}

/** The last heartbeat the panel saw. The clock is injectable so tests can move it. */
export function createLiveState(now: () => number = Date.now): LiveState {
  let payload: EventPayload<"bot.status"> | null = null;
  let lastSeen: number | null = null;
  return {
    record(next) {
      payload = next;
      lastSeen = now();
    },
    status: () => ({
      event: "bot.status",
      online: isBotOnline(lastSeen, now()),
      payload,
      lastSeen,
    }),
  };
}

/** The topic and the text an event goes out as. */
export function fanOut(event: BotEvent, live: LiveState): { topic: string; message: string } {
  switch (event.event) {
    case "bot.status":
      live.record(event.payload);
      return { topic: BOT_TOPIC, message: JSON.stringify(live.status()) };
    case "message.created":
    case "message.updated":
      return {
        topic: channelTopic(event.payload.message.channelId),
        message: JSON.stringify({ event: event.event, payload: event.payload }),
      };
    case "message.deleted":
      return {
        topic: channelTopic(event.payload.channelId),
        message: JSON.stringify({ event: event.event, payload: event.payload }),
      };
    case "music.state":
      return {
        topic: musicTopic(event.payload.guildId),
        message: JSON.stringify({ event: event.event, payload: event.payload }),
      };
    case "music.status":
      return {
        topic: BOT_TOPIC,
        message: JSON.stringify({ event: event.event, payload: event.payload }),
      };
  }
}

/**
 * Feeds the bot's events into `live` and out to the sockets subscribed to their topic. Bun sends a published
 * message only to the sockets on that topic, so message events reach only the sockets watching the channel.
 */
export function attachLive(
  server: { publish(topic: string, message: string): unknown },
  bot: Pick<BotClient, "onEvent">,
  live: LiveState,
): () => void {
  return bot.onEvent((event) => {
    const { topic, message } = fanOut(event, live);
    server.publish(topic, message);
  });
}

const SubscriptionType = z.enum(["subscribe", "unsubscribe"]);

/** What a client may send over the socket: one channel's messages, or one server's music player. */
export const ClientMessage = z.union([
  z.object({ type: SubscriptionType, channelId: Snowflake }).strict(),
  z.object({ type: SubscriptionType, musicGuildId: Snowflake }).strict(),
]);

/** The part of a Bun socket the subscription handling uses. */
export interface TopicSocket {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

/**
 * Handles what a client sends: `subscribe`/`unsubscribe` to one channel's events or one server's music.
 * Anything that does not match the schema closes the socket (1008); a subscribe past the per-socket limit
 * (channels and players together) is answered with `subscribe.rejected` and leaves the socket as it was.
 */
export function createSubscriptions() {
  const topics = new WeakMap<TopicSocket, Set<string>>();
  return {
    handle(ws: TopicSocket, raw: string | Buffer): void {
      let parsed: ReturnType<typeof ClientMessage.safeParse>;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
      } catch {
        ws.close(1008, "invalid message");
        return;
      }
      if (!parsed.success) {
        ws.close(1008, "invalid message");
        return;
      }
      const message = parsed.data;
      const { type } = message;
      const topic =
        "channelId" in message ? channelTopic(message.channelId) : musicTopic(message.musicGuildId);
      const own = topics.get(ws) ?? new Set<string>();
      topics.set(ws, own);
      if (type === "unsubscribe") {
        own.delete(topic);
        ws.unsubscribe(topic);
        return;
      }
      if (!own.has(topic) && own.size >= MAX_TOPICS_PER_SOCKET) {
        const target =
          "channelId" in message
            ? { channelId: message.channelId }
            : { musicGuildId: message.musicGuildId };
        ws.send(JSON.stringify({ event: "subscribe.rejected", ...target, reason: "too_many" }));
        return;
      }
      own.add(topic);
      ws.subscribe(topic);
    },
    /** Topics the socket is on, for tests. */
    of: (ws: TopicSocket): string[] => [...(topics.get(ws) ?? [])],
  };
}
