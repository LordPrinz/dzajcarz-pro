import { afterAll, describe, expect, test } from "bun:test";
import { createRedisPubSub, keepConnected } from "@dzajcarz/kv";
import { RedisClient } from "bun";
import { COMMAND_CHANNEL, EVENT_CHANNEL, replyChannel } from "./channels.ts";
import { createBotClient } from "./client.ts";
import { createCommandServer } from "./server.ts";
import { commandHandlers, recordingLogger } from "./testing.ts";

// Started while Redis is not connected yet, then stopped: once the connection comes up nothing may be left
// subscribed. Runs only when a disposable Redis is available (CI provides one).
const redisUrl = Bun.env.TEST_REDIS_URL;
const publisher = redisUrl ? new RedisClient(redisUrl) : undefined;
afterAll(() => publisher?.close());

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

describe.skipIf(!redisUrl)("stop before the subscriber connects", () => {
  const numSub = async (channel: string) => {
    const reply = (await publisher?.send("PUBSUB", ["NUMSUB", channel])) as [string, number];
    return reply[1];
  };

  /** A pub/sub whose subscriber is not connected; `connect` brings it up the way the apps do. */
  function disconnected() {
    if (!redisUrl || !publisher) throw new Error("unreachable");
    const subscriber = new RedisClient(redisUrl, { enableOfflineQueue: false });
    const pubsub = createRedisPubSub({ publisher, subscriber });
    let resubscribed = 0;
    return {
      pubsub,
      async connect() {
        keepConnected(
          subscriber,
          { warn() {} },
          {
            retryMs: 20,
            onConnect: async () => {
              await pubsub.resubscribe();
              resubscribed += 1;
            },
          },
        );
        await waitFor(() => resubscribed === 1);
      },
      close() {
        subscriber.onclose = null;
        subscriber.close();
      },
    };
  }

  test("the bot client leaves no reply or event subscription", async () => {
    const t = disconnected();
    const instanceId = crypto.randomUUID();
    const client = createBotClient({
      pubsub: t.pubsub,
      instanceId,
      timeoutMs: 100,
      logger: recordingLogger(),
    });
    await client.start();
    await client.stop();
    await t.connect();
    expect(await numSub(replyChannel(instanceId))).toBe(0);
    expect(t.pubsub.isSubscribed(EVENT_CHANNEL)).toBe(false);
    t.close();
  });

  test("the command server leaves no command subscription", async () => {
    const t = disconnected();
    const before = await numSub(COMMAND_CHANNEL);
    const server = createCommandServer({
      pubsub: t.pubsub,
      handlers: commandHandlers({ "guilds.list": async () => [] }),
      logger: recordingLogger(),
    });
    await server.start();
    await server.stop();
    await t.connect();
    expect(await numSub(COMMAND_CHANNEL)).toBe(before);
    expect(t.pubsub.isSubscribed(COMMAND_CHANNEL)).toBe(false);
    t.close();
  });
});
