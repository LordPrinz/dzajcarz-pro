import { describe, expect, test } from "bun:test";
import type { BotEvent } from "@dzajcarz/web-protocol";
import { attachLive, BOT_TOPIC, createLiveState, topicFor } from "./live.ts";

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
    expect(topicFor("bot.status")).toBe(BOT_TOPIC);
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toBe("bot");
    expect(JSON.parse(published[0]?.[1] ?? "")).toMatchObject({ online: true, payload: PAYLOAD });
    stop();
    expect(unsubscribed).toBe(1);
  });
});
