import type { PubSub, Unsubscribe } from "@dzajcarz/kv";
import { COMMAND_CHANNEL, EVENT_CHANNEL, REPLY_CHANNEL_PATTERN } from "./channels.ts";
import {
  COMMANDS,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
  isCommandName,
} from "./commands.ts";
import {
  CommandEnvelope,
  type ErrorCode,
  MAX_COMMAND_TTL_MS,
  type ReplyEnvelope,
  withinMessageLimit,
} from "./envelope.ts";
import { EVENTS, type EventName, type EventPayload } from "./events.ts";
import type { ProtocolLogger } from "./logger.ts";

/** One handler per command; a missing one is a compile error. */
export type CommandHandlers = {
  [N in CommandName]: (request: CommandRequest<N>) => Promise<CommandResponse<N>>;
};

export interface CommandServer {
  /** Starts listening for commands. Never throws: a subscription that fails is retried on reconnect. */
  start(): Promise<void>;
  /** Fire and forget; never rejects. */
  publishEvent<N extends EventName>(name: N, payload: EventPayload<N>): Promise<void>;
  stop(): Promise<void>;
}

export interface CommandServerOptions {
  pubsub: PubSub;
  handlers: CommandHandlers;
  logger: ProtocolLogger;
  now?: () => number;
  /** How many handled command ids are remembered (until their deadline) to drop a replayed one. */
  maxRememberedIds?: number;
}

/** The bot side of the protocol. */
export function createCommandServer({
  pubsub,
  handlers,
  logger,
  now = Date.now,
  maxRememberedIds = 10_000,
}: CommandServerOptions): CommandServer {
  let stopListening: Unsubscribe | undefined;
  /** Ids already accepted, with their deadline; in insertion order, so the oldest go first. */
  const seen = new Map<string, number>();

  /** False when the id was accepted before and its deadline has not passed. */
  function firstTime(id: string, deadline: number): boolean {
    const at = now();
    const known = seen.get(id);
    if (known !== undefined && known >= at) return false;
    seen.delete(id);
    for (const [knownId, knownDeadline] of seen) {
      if (knownDeadline >= at && seen.size < maxRememberedIds) break;
      seen.delete(knownId);
    }
    seen.set(id, deadline);
    return true;
  }

  async function reply(replyTo: string, envelope: ReplyEnvelope): Promise<void> {
    // The schema already checked `replyTo`; once more here, so nothing but a reply channel is published to.
    if (!REPLY_CHANNEL_PATTERN.test(replyTo)) return;
    try {
      await pubsub.publish(replyTo, JSON.stringify(envelope));
    } catch (error) {
      logger.debug("Could not publish a reply", { error });
    }
  }

  const fail = (id: string, code: ErrorCode, message: string): ReplyEnvelope => ({
    v: 1,
    id,
    ok: false,
    error: { code, message },
  });

  async function handle(raw: string): Promise<void> {
    if (!withinMessageLimit(raw)) {
      logger.warn("Dropped an oversized command");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn("Dropped a malformed command");
      return;
    }
    const parsed = CommandEnvelope.safeParse(json);
    if (!parsed.success) {
      logger.warn("Dropped a command that does not match the protocol");
      return;
    }
    const { id, replyTo, command, payload, deadline } = parsed.data;
    const at = now();
    if (at > deadline) {
      logger.debug("Dropped a command past its deadline", { command, id });
      return;
    }
    if (deadline > at + MAX_COMMAND_TTL_MS) {
      logger.warn("Dropped a command whose deadline is too far ahead", { command, id });
      return;
    }
    if (!firstTime(id, deadline)) {
      logger.warn("Dropped a replayed command", { command, id });
      return;
    }
    if (!isCommandName(command)) {
      await reply(replyTo, fail(id, "unknown_command", "Unknown command"));
      return;
    }
    const request = COMMANDS[command].request.safeParse(payload);
    if (!request.success) {
      await reply(replyTo, fail(id, "invalid", "The request does not match the command"));
      return;
    }
    let result: unknown;
    try {
      result = await (handlers[command] as (request: unknown) => Promise<unknown>)(request.data);
    } catch (error) {
      logger.error("Command handler failed", { command, error });
      await reply(replyTo, fail(id, "failed", "The command failed"));
      return;
    }
    const response = COMMANDS[command].response.safeParse(result);
    if (!response.success) {
      logger.error("Command handler returned data that does not match its schema", { command });
      await reply(replyTo, fail(id, "failed", "The command failed"));
      return;
    }
    await reply(replyTo, { v: 1, id, ok: true, result: response.data });
  }

  return {
    async start() {
      try {
        stopListening = await pubsub.subscribe(COMMAND_CHANNEL, (raw) => {
          void handle(raw).catch((error: unknown) =>
            logger.error("Command handling failed", { error }),
          );
        });
      } catch (error) {
        // The adapter keeps the listener and subscribes again when the connection comes back.
        logger.debug("Could not subscribe yet; will retry on reconnect", { error });
      }
    },

    async publishEvent(name, payload) {
      const checked = EVENTS[name].safeParse(payload);
      if (!checked.success) {
        logger.error("Refused to publish an event that does not match its schema", { event: name });
        return;
      }
      try {
        await pubsub.publish(
          EVENT_CHANNEL,
          JSON.stringify({ v: 1, event: name, payload: checked.data, at: now() }),
        );
      } catch (error) {
        logger.debug("Could not publish an event", { event: name, error });
      }
    },

    async stop() {
      await stopListening?.().catch(() => {});
      stopListening = undefined;
    },
  };
}
