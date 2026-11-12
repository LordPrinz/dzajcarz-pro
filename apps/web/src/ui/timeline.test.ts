import { describe, expect, test } from "bun:test";
import type { MessagePage, PanelMessage } from "./reading-api.ts";
import {
  applyLiveEvent,
  eventChannel,
  parseLiveEvent,
  type Timeline,
  timelineOf,
  withNewer,
  withOlder,
} from "./timeline.ts";

const CHANNEL = "200000000000000002";
const id = (n: number) => String(500000000000000000n + BigInt(n));

function message(n: number, overrides: Partial<PanelMessage> = {}): PanelMessage {
  return {
    id: id(n),
    guildId: null,
    channelId: CHANNEL,
    author: {
      id: "300000000000000003",
      username: "ola",
      displayName: null,
      avatarUrl: null,
      bot: false,
    },
    content: `m${n}`,
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 10, n)).toISOString(),
    editedAt: null,
    deletedAt: null,
    truncated: false,
    ...overrides,
  };
}

const page = (ns: number[], overrides: Partial<MessagePage> = {}): MessagePage => ({
  source: "archive",
  messages: ns.map((n) => message(n)),
  resolved: { users: {}, roles: {}, channels: {} },
  hasOlder: false,
  hasNewer: false,
  ...overrides,
});

const ids = (timeline: Timeline) => timeline.messages.map((m) => m.content);
const names = { users: { "300000000000000003": "Ola" }, roles: {}, channels: {} };

describe("pages", () => {
  test("older pages join at the top, newer at the bottom, without duplicates", () => {
    let timeline = timelineOf(page([5, 6], { hasOlder: true, hasNewer: true }));
    timeline = withOlder(timeline, page([3, 4, 5], { hasOlder: false, resolved: names }));
    expect(ids(timeline)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(timeline.hasOlder).toBe(false);
    expect(timeline.resolved.users).toEqual(names.users);
    timeline = withNewer(timeline, page([6, 7], { hasNewer: false }));
    expect(ids(timeline)).toEqual(["m3", "m4", "m5", "m6", "m7"]);
    expect(timeline.hasNewer).toBe(false);
  });
});

describe("live events", () => {
  const created = (n: number) => ({
    event: "message.created" as const,
    payload: { message: message(n), resolved: names },
  });

  test("a new message joins at the bottom with its names", () => {
    const timeline = applyLiveEvent(timelineOf(page([1])), created(2));
    expect(ids(timeline)).toEqual(["m1", "m2"]);
    expect(timeline.resolved.users).toEqual(names.users);
  });

  test("a new message waits while the view does not reach the latest one", () => {
    const timeline = timelineOf(page([1], { hasNewer: true }));
    expect(applyLiveEvent(timeline, created(2))).toBe(timeline);
  });

  test("an edit replaces the message on screen and keeps a deletion mark; unknown ones are ignored", () => {
    const deletedAt = "2026-11-01T12:00:00.000Z";
    const timeline = timelineOf({ ...page([]), messages: [message(1, { deletedAt })] });
    const edited = applyLiveEvent(timeline, {
      event: "message.updated",
      payload: {
        message: message(1, { content: "nowa", editedAt: "2026-11-01T11:00:00.000Z" }),
        resolved: names,
      },
    });
    expect(edited.messages).toEqual([
      message(1, { content: "nowa", editedAt: "2026-11-01T11:00:00.000Z", deletedAt }),
    ]);
    const other = applyLiveEvent(timeline, {
      event: "message.updated",
      payload: { message: message(9), resolved: names },
    });
    expect(other).toBe(timeline);
  });

  test("a deletion keeps the message and marks it", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    const timeline = applyLiveEvent(
      timelineOf(page([1, 2])),
      { event: "message.deleted", payload: { guildId: null, channelId: CHANNEL, ids: [id(2)] } },
      now,
    );
    expect(timeline.messages.map((m) => m.deletedAt)).toEqual([null, now.toISOString()]);
  });
});

describe("parseLiveEvent", () => {
  test("accepts the three message events and nothing else", () => {
    const created = { event: "message.created", payload: { message: message(1), resolved: names } };
    expect(parseLiveEvent(created)).toEqual(created as never);
    expect(eventChannel(parseLiveEvent(created) as never)).toBe(CHANNEL);
    const deleted = {
      event: "message.deleted",
      payload: { guildId: null, channelId: CHANNEL, ids: [id(1), 5] },
    };
    expect(parseLiveEvent(deleted)).toEqual({
      event: "message.deleted",
      payload: { guildId: null, channelId: CHANNEL, ids: [id(1)] },
    });
    expect(parseLiveEvent({ event: "bot.status", payload: {} })).toBeNull();
    expect(parseLiveEvent({ event: "message.created", payload: { message: {} } })).toBeNull();
    expect(parseLiveEvent("x")).toBeNull();
    expect(parseLiveEvent({ event: "subscribe.rejected", channelId: CHANNEL })).toBeNull();
  });
});
