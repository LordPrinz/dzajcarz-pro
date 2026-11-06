import type { ClientEvents } from "discord.js";
import type { AnyCommand } from "./command.ts";

export interface EventHandler<E extends keyof ClientEvents = keyof ClientEvents> {
  /** For logs: which handler failed. */
  name: string;
  event: E;
  once?: boolean;
  /**
   * Run even when the owning module is switched off for the guild or channel. For cleanup that must
   * not leave state behind (e.g. deleting empty channels the module created).
   */
  alwaysRun?: boolean;
  run(...args: ClientEvents[E]): Promise<void> | void;
}

/** Type-erased handler, as stored on a module. */
// biome-ignore lint/suspicious/noExplicitAny: the event key is erased once handlers share a list.
export type AnyEventHandler = EventHandler<any>;

export function defineEvent<E extends keyof ClientEvents>(
  handler: EventHandler<E>,
): AnyEventHandler {
  return handler;
}

/**
 * A feature of the bot (music, moderation, party…). Modules are built by a factory that receives only
 * the ports it needs, e.g. `createMusicModule({ player, logger })`; apps/bot wires the real adapters.
 */
export interface BotModule {
  name: string;
  commands?: readonly AnyCommand[];
  events?: readonly AnyEventHandler[];
  /** Called on shutdown, before the Discord client is destroyed: stop timers, flush buffers. */
  dispose?(): Promise<void> | void;
}
