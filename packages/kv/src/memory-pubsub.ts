import type { PubSub, PubSubListener } from "./pubsub.ts";

/** In-process `PubSub` for tests and local tools. Delivers synchronously; not shared between processes. */
export function createMemoryPubSub(): PubSub {
  const channels = new Map<string, Set<PubSubListener>>();

  return {
    async publish(channel, message) {
      const listeners = channels.get(channel);
      if (!listeners?.size) return 0;
      for (const listener of [...listeners]) {
        // A throwing listener must not stop the others or fail the publisher, as with Redis.
        try {
          listener(message);
        } catch {}
      }
      // Redis counts subscribed connections, so one process listening twice is still one receiver.
      return 1;
    },
    async subscribe(channel, listener) {
      let listeners = channels.get(channel);
      if (!listeners) {
        listeners = new Set();
        channels.set(channel, listeners);
      }
      // A wrapper per subscription, so subscribing the same function twice gives two independent handles.
      const own: PubSubListener = (message) => listener(message);
      listeners.add(own);
      return async () => {
        const current = channels.get(channel);
        current?.delete(own);
        if (current?.size === 0) channels.delete(channel);
      };
    },
  };
}
