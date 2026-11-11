import { z } from "zod";

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
} as const;

export type EventName = keyof typeof EVENTS;
export type EventPayload<N extends EventName> = z.infer<(typeof EVENTS)[N]>;

export const isEventName = (name: string): name is EventName => Object.hasOwn(EVENTS, name);

/** Whether the last heartbeat (epoch ms, or null when none came yet) is recent enough. */
export function isBotOnline(lastSeen: number | null, now: number): boolean {
  return lastSeen !== null && now - lastSeen < BOT_OFFLINE_AFTER_MS;
}
