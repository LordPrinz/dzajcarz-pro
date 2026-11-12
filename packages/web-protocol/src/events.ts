import { z } from "zod";
import { PanelMessage, Resolved } from "./messages.ts";
import { Snowflake } from "./snowflake.ts";

/** Bulk deletes cover at most 100 messages. */
export const MAX_DELETED_IDS = 100;

const MessageEvent = z.object({ message: PanelMessage, resolved: Resolved });

/** How often the bot publishes `bot.status`. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Three missed heartbeats and the panel treats the bot as offline. */
export const BOT_OFFLINE_AFTER_MS = 45_000;

/** Every event the bot can publish, by name. */
export const EVENTS = {
  "bot.status": z.object({
    guilds: z.number().int().nonnegative(),
    startedAt: z.iso.datetime(),
  }),
  /**
   * Every message the bot sees, archived or not; the panel passes each on only to the sockets watching its
   * channel. Nothing is stored on the way.
   */
  "message.created": MessageEvent,
  "message.updated": MessageEvent,
  "message.deleted": z.object({
    guildId: Snowflake.nullable(),
    channelId: Snowflake,
    ids: z.array(Snowflake).min(1).max(MAX_DELETED_IDS),
  }),
} as const;

export type EventName = keyof typeof EVENTS;
export type EventPayload<N extends EventName> = z.infer<(typeof EVENTS)[N]>;

export const isEventName = (name: string): name is EventName => Object.hasOwn(EVENTS, name);

/** Whether the last heartbeat (epoch ms, or null when none came yet) is recent enough. */
export function isBotOnline(lastSeen: number | null, now: number): boolean {
  return lastSeen !== null && now - lastSeen < BOT_OFFLINE_AFTER_MS;
}
