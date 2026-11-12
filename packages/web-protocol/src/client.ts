import type { PubSub, Unsubscribe } from "@dzajcarz/kv";
import { COMMAND_CHANNEL, EVENT_CHANNEL, replyChannel } from "./channels.ts";
import {
  COMMANDS,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
} from "./commands.ts";
import {
  EventEnvelope,
  MAX_COMMAND_TTL_MS,
  ReplyEnvelope,
  withinMessageLimit,
} from "./envelope.ts";
import { EVENTS, type EventName, type EventPayload, isEventName } from "./events.ts";
import type { ProtocolLogger } from "./logger.ts";

export type BotResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "unavailable" | "timeout" | "error"; message?: string };

export type BotEvent = {
  [N in EventName]: { event: N; payload: EventPayload<N>; at: number };
}[EventName];

export interface BotClient {
  /** Subscribes to replies and events. Never throws: a subscription that fails is retried on reconnect. */
  start(): Promise<void>;
  /**
   * Never throws and never rejects; every failure is a `BotResult`. `timeoutMs` replaces the client's own
   * wait for this one command (a slow one, such as a music search), at most `MAX_COMMAND_TTL_MS`.
   */
  request<N extends CommandName>(
    name: N,
    payload: CommandRequest<N>,
    options?: { timeoutMs?: number },
  ): Promise<BotResult<CommandResponse<N>>>;
  onEvent(listener: (event: BotEvent) => void): () => void;
  /** Requests still waiting for a reply. */
  pendingCount(): number;
  stop(): Promise<void>;
}

export interface BotClientOptions {
  pubsub: PubSub;
  /** Names this web instance's reply channel; a UUID. */
  instanceId?: string;
  timeoutMs: number;
  logger: ProtocolLogger;
  now?: () => number;
}

interface Pending {
  name: CommandName;
  finish(result: BotResult<never>): void;
}

const unavailable = { ok: false, reason: "unavailable" } as const;

/**
 * The web side of the protocol. `PUBLISH` returns how many bots received the command, so no receiver means
 * "unavailable" at once; a bot that received it and stays silent ends in "timeout". A request sent while the
 * reply channel is not subscribed (yet) is "unavailable" too, since its reply could not arrive.
 */
export function createBotClient({
  pubsub,
  instanceId = crypto.randomUUID(),
  timeoutMs,
  logger,
  now = Date.now,
}: BotClientOptions): BotClient {
  if (timeoutMs > MAX_COMMAND_TTL_MS) {
    // The bot drops a command whose deadline is further out than this.
    throw new RangeError(`timeoutMs must be at most ${MAX_COMMAND_TTL_MS}, got ${timeoutMs}`);
  }
  const ownReplyChannel = replyChannel(instanceId);
  const pending = new Map<string, Pending>();
  const eventListeners = new Set<(event: BotEvent) => void>();
  const stops: Unsubscribe[] = [];

  function handleReply(raw: string): void {
    if (!withinMessageLimit(raw)) {
      logger.warn("Dropped an oversized reply");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn("Dropped a malformed reply");
      return;
    }
    const reply = ReplyEnvelope.safeParse(json);
    if (!reply.success) {
      logger.warn("Dropped a reply that does not match the protocol");
      return;
    }
    // A reply after the timeout (or for another instance's id) has no entry: drop it.
    const entry = pending.get(reply.data.id);
    if (!entry) return;
    if (!reply.data.ok) {
      entry.finish({ ok: false, reason: "error", message: reply.data.error.message });
      return;
    }
    const data = COMMANDS[entry.name].response.safeParse(reply.data.result);
    if (!data.success) {
      logger.warn("Dropped a reply whose result does not match the command", {
        command: entry.name,
      });
      entry.finish({ ok: false, reason: "error", message: "The bot sent an invalid response" });
      return;
    }
    entry.finish({ ok: true, data: data.data as never });
  }

  function handleEvent(raw: string): void {
    if (!withinMessageLimit(raw)) {
      logger.warn("Dropped an oversized event");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn("Dropped a malformed event");
      return;
    }
    const envelope = EventEnvelope.safeParse(json);
    if (!envelope.success || !isEventName(envelope.data.event)) {
      logger.debug("Dropped an unknown or malformed event");
      return;
    }
    const { event, at } = envelope.data;
    const payload = EVENTS[event].safeParse(envelope.data.payload);
    if (!payload.success) {
      logger.warn("Dropped an event whose payload does not match", { event });
      return;
    }
    const botEvent = { event, payload: payload.data, at } as BotEvent;
    for (const listener of [...eventListeners]) {
      try {
        listener(botEvent);
      } catch (error) {
        logger.error("Event listener failed", { event, error });
      }
    }
  }

  async function subscribeTo(channel: string, listener: (raw: string) => void): Promise<void> {
    try {
      // A connection that is down does not reject: the adapter subscribes again when it comes back.
      stops.push(await pubsub.subscribe(channel, listener));
    } catch (error) {
      logger.warn("Could not subscribe", { channel, error });
    }
  }

  return {
    async start() {
      await subscribeTo(ownReplyChannel, handleReply);
      await subscribeTo(EVENT_CHANNEL, handleEvent);
    },

    request(name, payload, options = {}) {
      const parsed = COMMANDS[name].request.safeParse(payload);
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          reason: "error",
          message: "The request does not match the command",
        });
      }
      // Without the reply channel a bot's answer would be lost and the request would end in a timeout.
      if (!pubsub.isSubscribed(ownReplyChannel)) {
        logger.debug("Not subscribed to the reply channel yet", { command: name });
        return Promise.resolve(unavailable);
      }
      const id = crypto.randomUUID();
      const sentAt = now();
      const wait = Math.min(options.timeoutMs ?? timeoutMs, MAX_COMMAND_TTL_MS);
      const envelope = {
        v: 1,
        id,
        replyTo: ownReplyChannel,
        command: name,
        payload: parsed.data,
        sentAt,
        deadline: sentAt + wait,
      };
      return new Promise((resolve) => {
        let published = false;
        const finish = (result: BotResult<never>) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          resolve(result);
        };
        // A publish that never returns means Redis is not answering, which is "unavailable", not a slow bot.
        const timer = setTimeout(
          () => finish(published ? { ok: false, reason: "timeout" } : unavailable),
          wait,
        );
        pending.set(id, { name, finish });
        pubsub.publish(COMMAND_CHANNEL, JSON.stringify(envelope)).then(
          (receivers) => {
            published = true;
            if (receivers === 0) finish(unavailable);
          },
          (error: unknown) => {
            logger.debug("Could not publish a command", { command: name, error });
            finish(unavailable);
          },
        );
      });
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },

    pendingCount: () => pending.size,

    async stop() {
      for (const entry of [...pending.values()]) entry.finish(unavailable);
      eventListeners.clear();
      await Promise.all(stops.splice(0).map((stop) => stop().catch(() => {})));
    },
  };
}
