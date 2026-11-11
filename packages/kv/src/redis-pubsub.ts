import type { RedisClient } from "bun";
import type { PubSub, PubSubListener } from "./pubsub.ts";

export interface RedisPubSub extends PubSub {
  /**
   * Re-establishes every native subscription on the subscriber connection. Hand it to `keepConnected` as
   * `onConnect`: it runs after every (re)connect, so a subscription never silently stays dead.
   */
  resubscribe(): Promise<void>;
}

/** Where a native subscribe that failed (and waits for `resubscribe`) is reported. */
export interface PubSubLog {
  debug(message: string, fields?: Record<string, unknown>): void;
}

interface Channel {
  listeners: Set<PubSubListener>;
  /** The one function registered with Bun for this channel; it fans out to `listeners`. */
  dispatch: (message: string) => void;
  /** Whether the native subscription went through on the current connection. */
  active: boolean;
}

/**
 * `PubSub` on two Bun `RedisClient`s. A subscribed connection accepts nothing but (un)subscribe and ping, so
 * `subscriber` must be its own connection, never the one used for commands. There is one native subscription
 * per channel and the fan-out to listeners happens here.
 */
export function createRedisPubSub({
  publisher,
  subscriber,
  log = { debug() {} },
}: {
  publisher: RedisClient;
  subscriber: RedisClient;
  log?: PubSubLog;
}): RedisPubSub {
  const channels = new Map<string, Channel>();
  // Every native (un)subscribe runs one after the other, so two overlapping reconnects (or a subscribe during
  // one) can never register the same channel twice.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  }

  /** Skips a channel that was dropped meanwhile, or that a `resubscribe` already subscribed. */
  async function subscribeNatively(channel: string, entry: Channel): Promise<void> {
    if (channels.get(channel) !== entry || entry.active) return;
    await subscriber.subscribe(channel, entry.dispatch);
    entry.active = true;
  }

  async function unsubscribeNatively(channel: string): Promise<void> {
    // Bun throws (synchronously) when the connection is not in subscriber mode, i.e. holds none yet.
    try {
      await subscriber.unsubscribe(channel);
    } catch {}
  }

  return {
    publish: (channel, message) => publisher.publish(channel, message),

    isSubscribed: (channel) => (channels.get(channel)?.active ?? false) && subscriber.connected,

    async subscribe(channel, listener) {
      // A wrapper per subscription, so subscribing the same function twice gives two independent handles.
      const own: PubSubListener = (message) => listener(message);
      const entry = channels.get(channel);
      if (entry) entry.listeners.add(own);
      else {
        const listeners = new Set<PubSubListener>([own]);
        const created: Channel = {
          listeners,
          active: false,
          dispatch(message) {
            for (const each of [...listeners]) {
              // One failing listener must not starve the others.
              try {
                each(message);
              } catch {}
            }
          },
        };
        channels.set(channel, created);
        try {
          await serial(() => subscribeNatively(channel, created));
        } catch (error) {
          // Redis is down or still connecting: the listener stays registered and `resubscribe` subscribes the
          // channel on the next connect.
          log.debug("Could not subscribe yet; will retry on reconnect", { channel, error });
        }
      }
      return async () => {
        const current = channels.get(channel);
        if (!current?.listeners.delete(own) || current.listeners.size > 0) return;
        channels.delete(channel);
        current.active = false;
        await serial(() => unsubscribeNatively(channel));
      };
    },

    resubscribe: () =>
      serial(async () => {
        for (const [channel, entry] of channels) {
          // Whether or not Bun restored the subscription itself, drop it first so each message arrives once.
          entry.active = false;
          await unsubscribeNatively(channel);
          try {
            await subscribeNatively(channel, entry);
          } catch (error) {
            // One channel failing (e.g. NOPERM) must not leave the others unsubscribed.
            log.debug("Could not resubscribe; will retry on reconnect", { channel, error });
          }
        }
      }),
  };
}
