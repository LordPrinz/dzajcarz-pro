import type { BotClient, EventName, EventPayload } from "@dzajcarz/web-protocol";
import { isBotOnline } from "@dzajcarz/web-protocol";

/** The WebSocket topic an event is published to. Later tickets add `channel:<id>` and `music:<guildId>`. */
export const BOT_TOPIC = "bot";

export function topicFor(event: EventName): string {
  switch (event) {
    case "bot.status":
      return BOT_TOPIC;
  }
}

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

/** Feeds the bot's events into `live` and out to the sockets subscribed to their topic. */
export function attachLive(
  server: { publish(topic: string, message: string): unknown },
  bot: Pick<BotClient, "onEvent">,
  live: LiveState,
): () => void {
  return bot.onEvent((event) => {
    live.record(event.payload);
    server.publish(topicFor(event.event), JSON.stringify(live.status()));
  });
}
