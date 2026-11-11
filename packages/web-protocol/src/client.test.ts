import { describe, expect, test } from "bun:test";
import { createMemoryPubSub, type PubSub } from "@dzajcarz/kv";
import { COMMAND_CHANNEL } from "./channels.ts";
import { createBotClient } from "./client.ts";
import { createCommandServer } from "./server.ts";
import { recordingLogger } from "./testing.ts";

const guild = { id: "123456789012345678", name: "Dżajcarz", iconUrl: null, memberCount: 4 };

function setup(pubsub: PubSub = createMemoryPubSub(), timeoutMs = 50) {
  const logger = recordingLogger();
  const client = createBotClient({ pubsub, timeoutMs, logger });
  return { client, logger, pubsub };
}

async function withServer(pubsub: PubSub, handler: () => Promise<unknown>) {
  const server = createCommandServer({
    pubsub,
    logger: recordingLogger(),
    handlers: { "guilds.list": handler as never },
  });
  await server.start();
  return server;
}

describe("createBotClient", () => {
  test("a request round-trips through the command server", async () => {
    const { client, pubsub } = setup();
    await client.start();
    await withServer(pubsub, async () => [guild]);
    expect(await client.request("guilds.list", {})).toEqual({ ok: true, data: [guild] });
    expect(client.pendingCount()).toBe(0);
  });

  test("answers unavailable at once when nobody listens", async () => {
    const { client } = setup(undefined, 1_000);
    await client.start();
    const started = Date.now();
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(client.pendingCount()).toBe(0);
  });

  test("answers timeout when the bot receives the command and stays silent", async () => {
    const { client, pubsub } = setup(undefined, 50);
    await client.start();
    await pubsub.subscribe(COMMAND_CHANNEL, () => {});
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "timeout" });
    expect(client.pendingCount()).toBe(0);
  });

  test("a reply after the timeout is ignored and nothing is left pending", async () => {
    const { client, pubsub } = setup(undefined, 30);
    await client.start();
    let release: () => void = () => {};
    await withServer(
      pubsub,
      () =>
        new Promise((resolve) => {
          release = () => resolve([guild]);
        }),
    );
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "timeout" });
    release();
    await Bun.sleep(20);
    expect(client.pendingCount()).toBe(0);
  });

  test("the command carries a reply channel of this client and a deadline of sentAt plus the timeout", async () => {
    const { client, pubsub } = setup(undefined, 50);
    await client.start();
    const seen: Record<string, unknown>[] = [];
    await pubsub.subscribe(COMMAND_CHANNEL, (raw) => seen.push(JSON.parse(raw)));
    await client.request("guilds.list", {});
    const command = seen[0] as { replyTo: string; sentAt: number; deadline: number; v: number };
    expect(command.v).toBe(1);
    expect(command.replyTo).toMatch(/^dzajcarz:web:reply:[0-9a-f-]{36}$/);
    expect(command.deadline - command.sentAt).toBe(50);
  });

  test("a reply with an id nobody waits for does not settle the pending request", async () => {
    const { client, pubsub } = setup(undefined, 80);
    await client.start();
    await pubsub.subscribe(COMMAND_CHANNEL, (raw) => {
      const { replyTo } = JSON.parse(raw);
      void pubsub.publish(
        replyTo,
        JSON.stringify({ v: 1, id: crypto.randomUUID(), ok: true, result: [guild] }),
      );
    });
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "timeout" });
    expect(client.pendingCount()).toBe(0);
  });

  test("a reply that fails the response schema is an error", async () => {
    const { client, pubsub, logger } = setup();
    await client.start();
    // Reply by hand, bypassing the server's own response check.
    await pubsub.subscribe(COMMAND_CHANNEL, (raw) => {
      const { id, replyTo } = JSON.parse(raw);
      void pubsub.publish(replyTo, JSON.stringify({ v: 1, id, ok: true, result: [{ id: 1 }] }));
    });
    const result = await client.request("guilds.list", {});
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(logger.lines.some((line) => line.startsWith("warn:"))).toBe(true);
  });

  test("an error reply carries the message", async () => {
    const { client, pubsub } = setup();
    await client.start();
    await withServer(pubsub, async () => {
      throw new Error("secret detail");
    });
    expect(await client.request("guilds.list", {})).toEqual({
      ok: false,
      reason: "error",
      message: "The command failed",
    });
  });

  test("a publish that throws is unavailable", async () => {
    const pubsub: PubSub = {
      publish: async () => {
        throw new Error("redis down");
      },
      subscribe: async () => async () => {},
    };
    const { client } = setup(pubsub);
    await client.start();
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "unavailable" });
    expect(client.pendingCount()).toBe(0);
  });

  test("a publish that never returns is unavailable at the timeout", async () => {
    const pubsub: PubSub = {
      publish: () => new Promise(() => {}),
      subscribe: async () => async () => {},
    };
    const { client } = setup(pubsub, 30);
    await client.start();
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "unavailable" });
  });

  test("an invalid request is rejected before anything is published", async () => {
    const { client, pubsub } = setup();
    await client.start();
    let published = 0;
    await pubsub.subscribe(COMMAND_CHANNEL, () => {
      published += 1;
    });
    const result = await client.request("guilds.list", { extra: 1 } as never);
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(published).toBe(0);
  });

  test("events reach listeners and bad ones are dropped", async () => {
    const { client, pubsub } = setup();
    await client.start();
    const seen: unknown[] = [];
    const stop = client.onEvent((event) => seen.push(event));
    const server = createCommandServer({
      pubsub,
      logger: recordingLogger(),
      handlers: { "guilds.list": async () => [] },
    });
    await server.publishEvent("bot.status", { guilds: 2, startedAt: "2026-11-11T10:00:00.000Z" });
    await pubsub.publish("dzajcarz:web:event", "not json");
    await pubsub.publish(
      "dzajcarz:web:event",
      JSON.stringify({ v: 1, event: "nope", payload: {}, at: 1 }),
    );
    await pubsub.publish(
      "dzajcarz:web:event",
      JSON.stringify({ v: 1, event: "bot.status", payload: { guilds: "x" }, at: 1 }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "bot.status", payload: { guilds: 2 } });
    stop();
    await server.publishEvent("bot.status", { guilds: 3, startedAt: "2026-11-11T10:00:00.000Z" });
    expect(seen).toHaveLength(1);
  });

  test("oversized replies and events are dropped before parsing", async () => {
    const { client, pubsub, logger } = setup();
    await client.start();
    const seen: unknown[] = [];
    client.onEvent((event) => seen.push(event));
    const huge = JSON.stringify({ v: 1, event: "bot.status", payload: "x".repeat(70_000), at: 1 });
    await pubsub.publish("dzajcarz:web:event", huge);
    expect(seen).toEqual([]);
    expect(logger.lines).toContain("warn: Dropped an oversized event");

    let replyTo = "";
    await pubsub.subscribe(COMMAND_CHANNEL, (raw) => {
      replyTo = JSON.parse(raw).replyTo;
    });
    const waiting = client.request("guilds.list", {});
    await Bun.sleep(5);
    await pubsub.publish(replyTo, "ż".repeat(40_000));
    expect(logger.lines).toContain("warn: Dropped an oversized reply");
    expect(await waiting).toEqual({ ok: false, reason: "timeout" });
  });

  test("a timeout longer than a command may live is refused", () => {
    expect(() =>
      createBotClient({
        pubsub: createMemoryPubSub(),
        timeoutMs: 30_001,
        logger: recordingLogger(),
      }),
    ).toThrow(RangeError);
  });

  test("stop settles requests that are still waiting", async () => {
    const { client, pubsub } = setup(undefined, 5_000);
    await client.start();
    await pubsub.subscribe(COMMAND_CHANNEL, () => {});
    const waiting = client.request("guilds.list", {});
    await client.stop();
    expect(await waiting).toEqual({ ok: false, reason: "unavailable" });
  });
});
