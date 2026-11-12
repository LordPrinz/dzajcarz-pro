import { describe, expect, test } from "bun:test";
import type { BotEvent } from "@dzajcarz/web-protocol";
import {
  attachLive,
  BOT_TOPIC,
  channelTopic,
  createLiveState,
  createSubscriptions,
  fanOut,
  MAX_TOPICS_PER_SOCKET,
} from "./live.ts";

const PAYLOAD = { guilds: 2, startedAt: "2026-11-11T10:00:00.000Z" };

describe("createLiveState", () => {
  test("is offline until the first heartbeat", () => {
    expect(createLiveState(() => 1).status()).toEqual({
      event: "bot.status",
      online: false,
      payload: null,
      lastSeen: null,
    });
  });

  test("is online for 44.9 s after a heartbeat and offline at 45 s", () => {
    let clock = 1_000;
    const live = createLiveState(() => clock);
    live.record(PAYLOAD);
    clock += 44_900;
    expect(live.status()).toMatchObject({ online: true, payload: PAYLOAD, lastSeen: 1_000 });
    clock += 100;
    expect(live.status().online).toBe(false);
  });
});

describe("attachLive", () => {
  test("records an event and publishes the new status to the topic of that event", () => {
    const live = createLiveState(() => 5);
    const published: [string, string][] = [];
    let unsubscribed = 0;
    let listener: (event: BotEvent) => void = () => {};
    const stop = attachLive(
      { publish: (topic, message) => void published.push([topic, message]) },
      {
        onEvent: (next) => {
          listener = next;
          return () => {
            unsubscribed += 1;
          };
        },
      },
      live,
    );
    listener({ event: "bot.status", payload: PAYLOAD, at: 1 });
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toBe(BOT_TOPIC);
    expect(JSON.parse(published[0]?.[1] ?? "")).toMatchObject({ online: true, payload: PAYLOAD });
    stop();
    expect(unsubscribed).toBe(1);
  });
});

describe("fanOut", () => {
  test("message events go to their channel's topic, the status to everyone", () => {
    const live = createLiveState(() => 5);
    const deleted: BotEvent = {
      event: "message.deleted",
      payload: { guildId: null, channelId: "200000000000000002", ids: ["200000000000000003"] },
      at: 1,
    };
    expect(fanOut(deleted, live)).toEqual({
      topic: channelTopic("200000000000000002"),
      message: JSON.stringify({ event: deleted.event, payload: deleted.payload }),
    });
    expect(live.status().lastSeen).toBeNull();
    expect(fanOut({ event: "bot.status", payload: PAYLOAD, at: 1 }, live).topic).toBe(BOT_TOPIC);
    expect(live.status().lastSeen).toBe(5);
  });
});

describe("createSubscriptions", () => {
  function fakeSocket() {
    const socket = {
      topics: new Set<string>(),
      sent: [] as string[],
      closed: null as [number | undefined, string | undefined] | null,
      subscribe: (topic: string) => void socket.topics.add(topic),
      unsubscribe: (topic: string) => void socket.topics.delete(topic),
      send: (message: string) => void socket.sent.push(message),
      close: (code?: number, reason?: string) => {
        socket.closed = [code, reason];
      },
    };
    return socket;
  }
  const id = (n: number) => String(200000000000000000n + BigInt(n));
  const send = (type: string, channelId: string) => JSON.stringify({ type, channelId });

  test("subscribes and unsubscribes one channel", () => {
    const subscriptions = createSubscriptions();
    const ws = fakeSocket();
    subscriptions.handle(ws, send("subscribe", id(1)));
    subscriptions.handle(ws, send("subscribe", id(1)));
    expect([...ws.topics]).toEqual([channelTopic(id(1))]);
    expect(subscriptions.of(ws)).toEqual([channelTopic(id(1))]);
    subscriptions.handle(ws, Buffer.from(send("unsubscribe", id(1))));
    expect([...ws.topics]).toEqual([]);
    expect(ws.closed).toBeNull();
  });

  test.each([
    ["text that is not JSON", "subscribe everything"],
    ["an unknown type", send("publish", id(1))],
    ["an id that is not a snowflake", send("subscribe", "bot")],
    ["a topic smuggled as the id", send("subscribe", "1 channel:2")],
    ["extra keys", JSON.stringify({ type: "subscribe", channelId: id(1), topic: "bot" })],
    ["a JSON array", "[]"],
  ])("closes the socket on %s", (_label, raw) => {
    const ws = fakeSocket();
    createSubscriptions().handle(ws, raw);
    expect(ws.closed).toEqual([1008, "invalid message"]);
    expect(ws.topics.size).toBe(0);
  });

  test("refuses a subscription past the per-socket limit, sockets counted apart", () => {
    const subscriptions = createSubscriptions();
    const ws = fakeSocket();
    for (let i = 0; i <= MAX_TOPICS_PER_SOCKET; i += 1)
      subscriptions.handle(ws, send("subscribe", id(i)));
    expect(ws.topics.size).toBe(MAX_TOPICS_PER_SOCKET);
    expect(JSON.parse(ws.sent[0] ?? "")).toEqual({
      event: "subscribe.rejected",
      channelId: id(MAX_TOPICS_PER_SOCKET),
      reason: "too_many",
    });
    const other = fakeSocket();
    subscriptions.handle(other, send("subscribe", id(99)));
    expect(other.topics.size).toBe(1);
  });
});
