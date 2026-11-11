import type { RedisClient } from "bun";
import type { PubSub, PubSubListener } from "./pubsub.ts";

export interface RedisPubSub extends PubSub {
  /**
   * Re-establishes every native subscription on the subscriber connection. Hand it to `keepConnected` as
   * `onConnect`: it runs after every (re)connect, so a subscription never silently stays dead.
   */
  resubscribe(): Promise<void>;
}

interface Channel {
  listeners: Set<PubSubListener>;
  /** The one function registered with Bun for this channel; it fans out to `listeners`. */
  dispatch: (message: string) => void;
}

/**
 * `PubSub` on two Bun `RedisClient`s. A subscribed connection accepts nothing but (un)subscribe and ping, so
 * `subscriber` must be its own connection, never the one used for commands. There is one native subscription
 * per channel and the fan-out to listeners happens here.
 */
export function createRedisPubSub({
  publisher,
  subscriber,
}: {
  publisher: RedisClient;
  subscriber: RedisClient;
}): RedisPubSub {
  const channels = new Map<string, Channel>();

  return {
    publish: (channel, message) => publisher.publish(channel, message),

    async subscribe(channel, listener) {
      // A wrapper per subscription, so subscribing the same function twice gives two independent handles.
      const own: PubSubListener = (message) => listener(message);
      let entry = channels.get(channel);
      const first = !entry;
      if (!entry) {
        const listeners = new Set<PubSubListener>();
        entry = {
          listeners,
          dispatch(message) {
            for (const each of [...listeners]) {
              // One failing listener must not starve the others.
              try {
                each(message);
              } catch {}
            }
          },
        };
        channels.set(channel, entry);
      }
      entry.listeners.add(own);
      // If this throws (Redis is down) the listener stays registered: `resubscribe` runs on the next connect.
      if (first) await subscriber.subscribe(channel, entry.dispatch);
      return async () => {
        const current = channels.get(channel);
        if (!current?.listeners.delete(own) || current.listeners.size > 0) return;
        channels.delete(channel);
        try {
          await subscriber.unsubscribe(channel);
        } catch {}
      };
    },

    async resubscribe() {
      for (const [channel, { dispatch }] of channels) {
        // Whether or not Bun restored the subscription itself, drop it first so each message arrives once.
        // Bun throws (synchronously) when the connection is not in subscriber mode, i.e. holds none yet.
        try {
          await subscriber.unsubscribe(channel);
        } catch {}
        await subscriber.subscribe(channel, dispatch);
      }
    },
  };
}
