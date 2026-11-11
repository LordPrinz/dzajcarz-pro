import { describe, expect, test } from "bun:test";
import { createMemoryPubSub } from "@dzajcarz/kv";
import { COMMAND_CHANNEL, EVENT_CHANNEL, replyChannel } from "./channels.ts";
import { createCommandServer } from "./server.ts";
import { recordingLogger } from "./testing.ts";

const guild = { id: "123456789012345678", name: "Dżajcarz", iconUrl: null, memberCount: 4 };

function setup(handler: () => Promise<unknown> = async () => [guild], now = Date.now) {
  const pubsub = createMemoryPubSub();
  const logger = recordingLogger();
  let handled = 0;
  const server = createCommandServer({
    pubsub,
    logger,
    now,
    handlers: {
      "guilds.list": (async () => {
        handled += 1;
        return handler();
      }) as never,
    },
  });
  const id = crypto.randomUUID();
  const replyTo = replyChannel(id);
  const replies: unknown[] = [];
  const send = async (overrides: Record<string, unknown> = {}) => {
    const sentAt = now();
    await pubsub.publish(
      COMMAND_CHANNEL,
      JSON.stringify({
        v: 1,
        id,
        replyTo,
        command: "guilds.list",
        payload: {},
        sentAt,
        deadline: sentAt + 1_000,
        ...overrides,
      }),
    );
    await Bun.sleep(10);
  };
  return {
    server,
    pubsub,
    logger,
    id,
    replies,
    send,
    handled: () => handled,
    listen: () => pubsub.subscribe(replyTo, (raw) => replies.push(JSON.parse(raw))),
  };
}

describe("createCommandServer", () => {
  test("stop unsubscribes from the command channel", async () => {
    const t = setup();
    await t.server.start();
    expect(t.pubsub.isSubscribed(COMMAND_CHANNEL)).toBe(true);
    await t.server.stop();
    expect(t.pubsub.isSubscribed(COMMAND_CHANNEL)).toBe(false);
  });

  test("runs the handler and replies with its result", async () => {
    const t = setup();
    await t.server.start();
    await t.listen();
    await t.send();
    expect(t.replies).toEqual([{ v: 1, id: t.id, ok: true, result: [guild] }]);
  });

  test("an unknown command is answered with unknown_command and its name is not echoed", async () => {
    const t = setup();
    await t.server.start();
    await t.listen();
    await t.send({ command: "nope.nothing" });
    expect(t.replies[0]).toMatchObject({
      ok: false,
      error: { code: "unknown_command", message: "Unknown command" },
    });
    expect(JSON.stringify(t.replies)).not.toContain("nope");
    expect(t.handled()).toBe(0);
  });

  test.each([
    ["upper case", "Guilds.list"],
    ["no dot", "guilds"],
    ["markup", "<script>.x"],
    ["over 64 characters", `a.${"b".repeat(63)}`],
  ])("a command name with %s is dropped without a reply", async (_label, command) => {
    const t = setup();
    await t.server.start();
    await t.listen();
    await t.send({ command });
    expect(t.replies).toEqual([]);
    expect(t.logger.lines).toContain("warn: Dropped a command that does not match the protocol");
  });

  test("a deadline more than 30 s after sentAt is dropped", async () => {
    const clock = 10_000;
    const t = setup(undefined, () => clock);
    await t.server.start();
    await t.listen();
    await t.send({ sentAt: clock, deadline: clock + 30_001 });
    expect(t.handled()).toBe(0);
    expect(t.replies).toEqual([]);
  });

  test("a deadline more than 30 s from now is dropped, whatever sentAt claims", async () => {
    const clock = 10_000;
    const t = setup(undefined, () => clock);
    await t.server.start();
    await t.listen();
    await t.send({ sentAt: clock + 20_000, deadline: clock + 40_000 });
    expect(t.handled()).toBe(0);
    expect(t.logger.lines).toContain("warn: Dropped a command whose deadline is too far ahead");
  });

  test("a replayed command id runs once", async () => {
    const t = setup();
    await t.server.start();
    await t.listen();
    await t.send();
    await t.send();
    expect(t.handled()).toBe(1);
    expect(t.replies).toHaveLength(1);
    expect(t.logger.lines).toContain("warn: Dropped a replayed command");
  });

  test("remembered ids are forgotten after their deadline and when there are too many", async () => {
    let clock = 10_000;
    const pubsub = createMemoryPubSub();
    let handled = 0;
    const server = createCommandServer({
      pubsub,
      logger: recordingLogger(),
      now: () => clock,
      maxRememberedIds: 2,
      handlers: {
        "guilds.list": async () => {
          handled += 1;
          return [];
        },
      },
    });
    await server.start();
    const send = async (id: string) => {
      await pubsub.publish(
        COMMAND_CHANNEL,
        JSON.stringify({
          v: 1,
          id,
          replyTo: replyChannel(crypto.randomUUID()),
          command: "guilds.list",
          payload: {},
          sentAt: clock,
          deadline: clock + 1_000,
        }),
      );
      await Bun.sleep(5);
    };
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await send(a);
    await send(b);
    await send(c); // pushes `a` out: only two are kept
    await send(a);
    expect(handled).toBe(4);
    await send(c);
    expect(handled).toBe(4);
    clock += 2_000; // every deadline has passed, so a reuse is no longer a replay
    await send(c);
    expect(handled).toBe(5);
  });

  test("an oversized command is dropped before parsing", async () => {
    const t = setup();
    await t.server.start();
    await t.listen();
    await t.send({ payload: { padding: "x".repeat(70_000) } });
    expect(t.handled()).toBe(0);
    expect(t.replies).toEqual([]);
    expect(t.logger.lines).toContain("warn: Dropped an oversized command");
  });

  test("an invalid payload is answered with invalid", async () => {
    const t = setup();
    await t.server.start();
    await t.listen();
    await t.send({ payload: { extra: true } });
    expect(t.replies[0]).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(t.handled()).toBe(0);
  });

  test("a throwing handler is answered with a generic failure and no stack", async () => {
    const t = setup(async () => {
      throw new Error("db password leaked");
    });
    await t.server.start();
    await t.listen();
    await t.send();
    expect(t.replies[0]).toEqual({
      v: 1,
      id: t.id,
      ok: false,
      error: { code: "failed", message: "The command failed" },
    });
    expect(JSON.stringify(t.replies)).not.toContain("leaked");
  });

  test("a handler that returns bad data never sends it", async () => {
    const t = setup(async () => [{ id: "x" }]);
    await t.server.start();
    await t.listen();
    await t.send();
    expect(t.replies[0]).toMatchObject({ ok: false, error: { code: "failed" } });
  });

  test("malformed JSON is dropped and logged", async () => {
    const t = setup();
    await t.server.start();
    await t.pubsub.publish(COMMAND_CHANNEL, "{not json");
    await Bun.sleep(10);
    expect(t.logger.lines).toContain("warn: Dropped a malformed command");
    expect(t.handled()).toBe(0);
  });

  test("a command past its deadline runs nothing and gets no reply", async () => {
    let clock = 10_000;
    const t = setup(undefined, () => clock);
    await t.server.start();
    await t.listen();
    const sentAt = clock;
    clock += 5_000;
    await t.send({ sentAt, deadline: sentAt + 1_000 });
    expect(t.handled()).toBe(0);
    expect(t.replies).toEqual([]);
    expect(t.logger.lines).toContain("debug: Dropped a command past its deadline");
  });

  test("a reply channel that is not a reply channel is dropped and nothing is published", async () => {
    const t = setup();
    await t.server.start();
    const published: string[] = [];
    await t.pubsub.subscribe(EVENT_CHANNEL, (raw) => published.push(raw));
    await t.send({ replyTo: EVENT_CHANNEL });
    expect(published).toEqual([]);
    expect(t.handled()).toBe(0);
  });

  test.each([
    ["too short", "dzajcarz:web:reply:abc"],
    ["a foreign prefix", "other:web:reply:123e4567-e89b-12d3-a456-426614174000"],
    ["uppercase hex", "dzajcarz:web:reply:123E4567-E89B-12D3-A456-426614174000"],
    ["a trailing suffix", "dzajcarz:web:reply:123e4567-e89b-12d3-a456-426614174000:x"],
  ])("a reply channel that is %s is never answered", async (_label, replyTo) => {
    const t = setup();
    await t.server.start();
    const published: string[] = [];
    await t.pubsub.subscribe(replyTo, (raw) => published.push(raw));
    await t.send({ replyTo });
    expect(published).toEqual([]);
    expect(t.handled()).toBe(0);
  });

  test("a command exactly at its deadline still runs", async () => {
    const clock = 10_000;
    const t = setup(undefined, () => clock);
    await t.server.start();
    await t.listen();
    await t.send({ sentAt: clock - 1_000, deadline: clock });
    expect(t.handled()).toBe(1);
  });

  test("stop stops answering", async () => {
    const t = setup();
    await t.server.start();
    await t.server.stop();
    expect(await t.pubsub.publish(COMMAND_CHANNEL, "{}")).toBe(0);
  });

  test("publishEvent refuses a payload that does not match its schema", async () => {
    const t = setup();
    const events: string[] = [];
    await t.pubsub.subscribe(EVENT_CHANNEL, (raw) => events.push(raw));
    await t.server.publishEvent("bot.status", { guilds: -1, startedAt: "x" });
    expect(events).toEqual([]);
    expect(t.logger.lines.some((line) => line.startsWith("error:"))).toBe(true);
  });
});
