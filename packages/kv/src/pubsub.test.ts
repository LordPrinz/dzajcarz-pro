import { afterAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { createMemoryPubSub } from "./memory-pubsub.ts";
import type { PubSub } from "./pubsub.ts";
import { keepConnected } from "./redis.ts";
import { createRedisPubSub, type PubSubLog } from "./redis-pubsub.ts";

// Shared contract: every PubSub adapter must pass the same suite. The Redis adapter runs only when a
// disposable Redis is available (CI provides one). Channel names are random, so runs never collide.
const redisUrl = Bun.env.TEST_REDIS_URL;
const publisher = redisUrl ? new RedisClient(redisUrl) : undefined;
const subscriber = redisUrl ? new RedisClient(redisUrl) : undefined;
afterAll(() => {
  publisher?.close();
  subscriber?.close();
});

const channelName = () => `test:pubsub:${crypto.randomUUID()}`;

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

const adapters: [string, (log?: PubSubLog) => PubSub][] = [
  ["memory", (log) => createMemoryPubSub({ log })],
];
if (publisher && subscriber) {
  adapters.push(["redis", (log) => createRedisPubSub({ publisher, subscriber, log })]);
}

describe.each(adapters)("PubSub (%s)", (_name, make) => {
  test("publish returns 0 while nobody listens", async () => {
    expect(await make().publish(channelName(), "hello")).toBe(0);
  });

  test("a listener gets the messages in order and publish counts a receiver", async () => {
    const pubsub = make();
    const channel = channelName();
    const received: string[] = [];
    const stop = await pubsub.subscribe(channel, (message) => received.push(message));
    expect(await pubsub.publish(channel, "one")).toBe(1);
    await pubsub.publish(channel, "two");
    await pubsub.publish(channel, "three");
    await waitFor(() => received.length === 3);
    expect(received).toEqual(["one", "two", "three"]);
    await stop();
  });

  test("unsubscribing stops delivery to that listener only", async () => {
    const pubsub = make();
    const channel = channelName();
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = await pubsub.subscribe(channel, (message) => first.push(message));
    const stopSecond = await pubsub.subscribe(channel, (message) => second.push(message));
    await pubsub.publish(channel, "a");
    await waitFor(() => first.length === 1 && second.length === 1);
    await stopFirst();
    await pubsub.publish(channel, "b");
    await waitFor(() => second.length === 2);
    await Bun.sleep(30);
    expect(first).toEqual(["a"]);
    expect(second).toEqual(["a", "b"]);
    await stopSecond();
  });

  test("isSubscribed follows subscribe and unsubscribe", async () => {
    const pubsub = make();
    const channel = channelName();
    expect(pubsub.isSubscribed(channel)).toBe(false);
    const stop = await pubsub.subscribe(channel, () => {});
    expect(pubsub.isSubscribed(channel)).toBe(true);
    await stop();
    expect(pubsub.isSubscribed(channel)).toBe(false);
  });

  test("unsubscribing twice is harmless", async () => {
    const pubsub = make();
    const channel = channelName();
    const stop = await pubsub.subscribe(channel, () => {});
    await stop();
    await stop();
    expect(await pubsub.publish(channel, "x")).toBe(0);
  });

  test("a throwing listener does not stop the others", async () => {
    const warnings: string[] = [];
    const pubsub = make({ debug() {}, warn: (message) => void warnings.push(message) });
    const channel = channelName();
    const received: string[] = [];
    await pubsub.subscribe(channel, () => {
      throw new Error("boom");
    });
    await pubsub.subscribe(channel, (message) => received.push(message));
    await pubsub.publish(channel, "still delivered");
    await waitFor(() => received.length === 1);
    expect(warnings).toEqual(["A pub/sub listener threw"]);
  });

  test("channels are independent", async () => {
    const pubsub = make();
    const [a, b] = [channelName(), channelName()];
    const received: string[] = [];
    await pubsub.subscribe(a, (message) => received.push(message));
    expect(await pubsub.publish(b, "wrong channel")).toBe(0);
    await Bun.sleep(30);
    expect(received).toEqual([]);
  });
});

describe.skipIf(!redisUrl)("createRedisPubSub", () => {
  const numSub = async (channel: string) => {
    const reply = (await publisher?.send("PUBSUB", ["NUMSUB", channel])) as [string, number];
    return reply[1];
  };

  test("two listeners share one native subscription and the last unsubscribe drops it", async () => {
    if (!publisher || !subscriber) throw new Error("unreachable");
    const pubsub = createRedisPubSub({ publisher, subscriber });
    const channel = channelName();
    const stopA = await pubsub.subscribe(channel, () => {});
    const stopB = await pubsub.subscribe(channel, () => {});
    expect(await numSub(channel)).toBe(1);
    await stopA();
    expect(await numSub(channel)).toBe(1);
    await stopB();
    expect(await numSub(channel)).toBe(0);
  });

  /** Starts `keepConnected` with `resubscribe` as its hook and counts the hook's completed runs. */
  function reconnect(own: RedisClient, pubsub: ReturnType<typeof createRedisPubSub>): () => number {
    let resubscribed = 0;
    keepConnected(
      own,
      { warn() {} },
      {
        retryMs: 20,
        onConnect: async () => {
          await pubsub.resubscribe();
          resubscribed += 1;
        },
      },
    );
    return () => resubscribed;
  }

  /** A subscriber with its own connection and `keepConnected`, as the apps build it. */
  async function connected() {
    if (!redisUrl || !publisher) throw new Error("unreachable");
    const own = new RedisClient(redisUrl, { enableOfflineQueue: false });
    const pubsub = createRedisPubSub({ publisher, subscriber: own });
    const resubscribed = reconnect(own, pubsub);
    await waitFor(() => resubscribed() === 1);
    return { own, pubsub, resubscribed };
  }

  test("after the subscriber reconnects through keepConnected a message arrives exactly once", async () => {
    const { own, pubsub, resubscribed } = await connected();
    const channel = channelName();
    const received: string[] = [];
    await pubsub.subscribe(channel, (message) => received.push(message));
    own.close();
    await waitFor(() => resubscribed() === 2);
    expect(await publisher?.publish(channel, "once")).toBe(1);
    await waitFor(() => received.length === 1);
    await Bun.sleep(50);
    expect(received).toEqual(["once"]);
    own.onclose = null;
    own.close();
  });

  test("a channel subscribed while the connection is down is subscribed once it connects", async () => {
    if (!redisUrl || !publisher) throw new Error("unreachable");
    const own = new RedisClient(redisUrl, { enableOfflineQueue: false });
    const channel = channelName();
    const received: string[] = [];
    const logged: string[] = [];
    const pubsub = createRedisPubSub({
      publisher,
      subscriber: own,
      log: { debug: (message) => void logged.push(message), warn() {} },
    });
    // Not connected yet: the native subscribe fails, the listener stays registered and a handle comes back.
    await pubsub.subscribe(channel, (message) => received.push(message));
    expect(pubsub.isSubscribed(channel)).toBe(false);
    expect(logged).toEqual(["Could not subscribe yet; will retry on reconnect"]);
    const resubscribed = reconnect(own, pubsub);
    await waitFor(() => resubscribed() === 1);
    expect(pubsub.isSubscribed(channel)).toBe(true);
    expect(await publisher.publish(channel, "once")).toBe(1);
    await waitFor(() => received.length === 1);
    await Bun.sleep(50);
    expect(received).toEqual(["once"]);
    own.onclose = null;
    own.close();
  });

  test("a channel subscribed and dropped while the connection is down stays unsubscribed", async () => {
    if (!redisUrl || !publisher) throw new Error("unreachable");
    const own = new RedisClient(redisUrl, { enableOfflineQueue: false });
    const pubsub = createRedisPubSub({ publisher, subscriber: own });
    const channel = channelName();
    const received: string[] = [];
    const stop = await pubsub.subscribe(channel, (message) => received.push(message));
    await stop();
    const resubscribed = reconnect(own, pubsub);
    await waitFor(() => resubscribed() === 1);
    expect(await numSub(channel)).toBe(0);
    expect(await publisher.publish(channel, "nobody")).toBe(0);
    await Bun.sleep(50);
    expect(received).toEqual([]);
    own.onclose = null;
    own.close();
  });

  test("overlapping resubscribes register a channel once", async () => {
    const { own, pubsub } = await connected();
    const channel = channelName();
    const received: string[] = [];
    await pubsub.subscribe(channel, (message) => received.push(message));
    await Promise.all([pubsub.resubscribe(), pubsub.resubscribe(), pubsub.resubscribe()]);
    expect(await numSub(channel)).toBe(1);
    expect(await publisher?.publish(channel, "once")).toBe(1);
    await waitFor(() => received.length === 1);
    await Bun.sleep(50);
    expect(received).toEqual(["once"]);
    own.onclose = null;
    own.close();
  });

  test("isSubscribed is false while the subscriber connection is down", async () => {
    const { own, pubsub } = await connected();
    const channel = channelName();
    await pubsub.subscribe(channel, () => {});
    expect(pubsub.isSubscribed(channel)).toBe(true);
    own.onclose = null;
    own.close();
    expect(pubsub.isSubscribed(channel)).toBe(false);
  });

  test("after Bun's own auto-reconnect a message arrives exactly once", async () => {
    const { own, pubsub, resubscribed } = await connected();
    const channel = channelName();
    const received: string[] = [];
    await pubsub.subscribe(channel, (message) => received.push(message));
    await publisher?.send("CLIENT", ["KILL", "TYPE", "pubsub"]);
    await waitFor(() => resubscribed() === 2);
    expect(await publisher?.publish(channel, "once")).toBe(1);
    await waitFor(() => received.length === 1);
    await Bun.sleep(50);
    expect(received).toEqual(["once"]);
    own.onclose = null;
    own.close();
  });
});

describe("createRedisPubSub unsubscribe", () => {
  test("logs a native unsubscribe that fails instead of swallowing it", async () => {
    const warnings: string[] = [];
    const subscriber = {
      connected: true,
      subscribe: async () => 1,
      unsubscribe: async () => {
        throw new Error("not in subscriber mode");
      },
    } as unknown as RedisClient;
    const pubsub = createRedisPubSub({
      publisher: {} as RedisClient,
      subscriber,
      log: { debug() {}, warn: (message) => void warnings.push(message) },
    });
    const stop = await pubsub.subscribe("c", () => {});
    await stop();
    expect(warnings).toEqual(["Could not unsubscribe"]);
  });
});
