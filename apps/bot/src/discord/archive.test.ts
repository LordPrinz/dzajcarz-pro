import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { silentLogger } from "@dzajcarz/core";
import { settle } from "@dzajcarz/core/testing/settle";
import type { ArchivedMessageInput } from "@dzajcarz/db";
import { MAX_CHANNELS } from "@dzajcarz/web-protocol";
import { ChannelType, type Client, Events, type Message, RESTJSONErrorCodes } from "discord.js";
import type { ArchivePlace, ArchiveRecorder } from "../archive-recorder.ts";
import {
  attachArchiveRecorder,
  createChannelHistory,
  createGuildChannelList,
  toArchivedMessage,
} from "./archive.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const THREAD = "200000000000000003";
const CREATED = new Date("2026-11-01T10:00:00.000Z");

const textChannel = { id: CHANNEL, isThread: () => false, isTextBased: () => true };
const thread = { id: THREAD, parentId: CHANNEL, isThread: () => true, isTextBased: () => true };

function fakeMessage(overrides: Record<string, unknown> = {}) {
  const attachments = [
    {
      id: "400000000000000004",
      name: "kot.png",
      url: "https://cdn.discordapp.com/attachments/1/2/kot.png",
      contentType: "image/png",
      size: 10,
      width: 1,
      height: 2,
    },
  ];
  return {
    id: "500000000000000001",
    guildId: GUILD,
    channelId: CHANNEL,
    channel: textChannel,
    partial: false,
    author: {
      id: "300000000000000003",
      username: "ola",
      globalName: "Ola G",
      bot: false,
      displayAvatarURL: () => "https://cdn.discordapp.com/avatars/3/a.png",
    },
    member: { displayName: "Ola na serwerze" },
    content: "hej",
    attachments: { map: <T>(fn: (a: (typeof attachments)[number]) => T) => attachments.map(fn) },
    embeds: [{ toJSON: () => ({ title: "Link" }) }],
    reference: { messageId: "500000000000000000" },
    createdAt: CREATED,
    editedAt: null,
    ...overrides,
  } as unknown as Message;
}

describe("toArchivedMessage", () => {
  test("keeps the author snapshot, links to files and the reply", () => {
    expect(toArchivedMessage(fakeMessage())).toEqual({
      id: "500000000000000001",
      guildId: GUILD,
      channelId: CHANNEL,
      author: {
        id: "300000000000000003",
        username: "ola",
        displayName: "Ola na serwerze",
        avatarUrl: "https://cdn.discordapp.com/avatars/3/a.png",
        bot: false,
      },
      content: "hej",
      attachments: [
        {
          id: "400000000000000004",
          name: "kot.png",
          url: "https://cdn.discordapp.com/attachments/1/2/kot.png",
          contentType: "image/png",
          size: 10,
          width: 1,
          height: 2,
        },
      ],
      embeds: [{ title: "Link" }],
      replyToId: "500000000000000000",
      createdAt: CREATED,
      editedAt: null,
    });
  });

  test("drops U+0000, which Postgres refuses, from text and JSON", () => {
    const archived = toArchivedMessage(
      fakeMessage({
        content: "a\0b",
        member: { displayName: "O\0la" },
        embeds: [{ toJSON: () => ({ title: "t\0", fields: [{ name: "\0n", value: "v" }] }) }],
      }),
    );
    expect(archived.content).toBe("ab");
    expect(archived.author.displayName).toBe("Ola");
    expect(archived.embeds).toEqual([{ title: "t", fields: [{ name: "n", value: "v" }] }]);
    expect(JSON.stringify(archived)).not.toContain("\\u0000");
  });

  test("a DM has no guild or member, and a plain message no reply", () => {
    const archived = toArchivedMessage(
      fakeMessage({ guildId: null, member: null, reference: null }),
    );
    expect(archived).toMatchObject({ guildId: null, replyToId: null });
    expect(archived.author.displayName).toBe("Ola G");
  });
});

function recordingRecorder() {
  const calls: unknown[][] = [];
  const recorder: ArchiveRecorder = {
    async created(place, message) {
      calls.push(["created", message.id, place.parentId]);
    },
    async updated(place, messageId, load) {
      calls.push(["updated", messageId, (await load())?.content ?? null, place.parentId]);
    },
    async deleted(place: ArchivePlace, ids) {
      calls.push(["deleted", place, [...ids]]);
    },
  };
  return { recorder, calls };
}

/** A client whose cache holds `cached` and whose API also knows `fetchable`. */
function fakeClient(cached: Record<string, unknown> = {}, fetchable: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const known = { ...fetchable, ...cached };
  return Object.assign(emitter, {
    channels: {
      cache: new Map(Object.entries(cached)),
      fetch: async (id: string) => {
        const channel = known[id];
        if (!channel) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        return channel;
      },
    },
  }) as unknown as Client & EventEmitter;
}

/** Lets the listeners, which are async, finish. */

const ID = "500000000000000001";

describe("attachArchiveRecorder", () => {
  test("passes creates, edits, deletes and bulk deletes on, with a thread's parent", async () => {
    const client = fakeClient({ [THREAD]: thread });
    const { recorder, calls } = recordingRecorder();
    attachArchiveRecorder(client, recorder, silentLogger);

    client.emit(Events.MessageCreate, fakeMessage());
    client.emit(Events.MessageCreate, fakeMessage({ channelId: THREAD, channel: thread }));
    client.emit(Events.MessageUpdate, null, fakeMessage({ content: "poprawione" }));
    client.emit(Events.MessageDelete, { id: "1", guildId: GUILD, channelId: THREAD });
    client.emit(
      Events.MessageBulkDelete,
      new Map([
        ["2", {}],
        ["3", {}],
      ]),
      { ...textChannel, guildId: GUILD },
    );
    await settle();

    // The listeners are async, so the order of the calls is not the point.
    expect(calls).toHaveLength(5);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["created", ID, null],
        ["created", ID, CHANNEL],
        ["updated", ID, "poprawione", null],
        ["deleted", { guildId: GUILD, channelId: THREAD, parentId: CHANNEL }, ["1"]],
        ["deleted", { guildId: GUILD, channelId: CHANNEL, parentId: null }, ["2", "3"]],
      ]),
    );
  });

  test("a thread missing from the cache is fetched, so its parent's exclusion still applies", async () => {
    const client = fakeClient({}, { [THREAD]: thread });
    const { recorder, calls } = recordingRecorder();
    attachArchiveRecorder(client, recorder, silentLogger);
    client.emit(Events.MessageDelete, { id: "1", guildId: GUILD, channelId: THREAD });
    await settle();
    expect(calls).toEqual([
      ["deleted", { guildId: GUILD, channelId: THREAD, parentId: CHANNEL }, ["1"]],
    ]);
  });

  test("a server channel that cannot be found is skipped; a DM needs no lookup", async () => {
    const client = fakeClient();
    const { recorder, calls } = recordingRecorder();
    attachArchiveRecorder(client, recorder, silentLogger);
    client.emit(Events.MessageDelete, { id: "1", guildId: GUILD, channelId: THREAD });
    client.emit(Events.MessageDelete, { id: "2", guildId: null, channelId: CHANNEL });
    await settle();
    expect(calls).toEqual([
      ["deleted", { guildId: null, channelId: CHANNEL, parentId: null }, ["2"]],
    ]);
  });

  test("a thread without a known parent is skipped", async () => {
    const orphan = { ...thread, parentId: null };
    const client = fakeClient({ [THREAD]: orphan });
    const { recorder, calls } = recordingRecorder();
    attachArchiveRecorder(client, recorder, silentLogger);
    client.emit(Events.MessageCreate, fakeMessage({ channelId: THREAD, channel: orphan }));
    await settle();
    expect(calls).toEqual([]);
  });

  test("fetches a partial edit before recording it", async () => {
    const client = fakeClient({ [CHANNEL]: textChannel });
    const { recorder, calls } = recordingRecorder();
    attachArchiveRecorder(client, recorder, silentLogger);
    const whole = fakeMessage({ content: "z serwera" });
    client.emit(Events.MessageUpdate, null, {
      id: ID,
      partial: true,
      guildId: GUILD,
      channelId: CHANNEL,
      fetch: async () => whole,
    });
    await settle();
    expect(calls).toEqual([["updated", ID, "z serwera", null]]);
  });

  test("an edit of a message that is gone by now is skipped quietly", async () => {
    const client = fakeClient({ [CHANNEL]: textChannel });
    const { recorder, calls } = recordingRecorder();
    const errors: string[] = [];
    attachArchiveRecorder(client, recorder, {
      ...silentLogger,
      error: (message) => void errors.push(message),
    });
    client.emit(Events.MessageUpdate, null, {
      id: ID,
      partial: true,
      guildId: GUILD,
      channelId: CHANNEL,
      fetch: async () => {
        throw Object.assign(new Error("Unknown Message"), {
          code: RESTJSONErrorCodes.UnknownMessage,
        });
      },
    });
    await settle();
    expect(calls).toEqual([["updated", ID, null, null]]);
    expect(errors).toEqual([]);
  });

  test("any other failure is logged and goes no further", async () => {
    const client = fakeClient({ [CHANNEL]: textChannel });
    const errors: string[] = [];
    attachArchiveRecorder(client, recordingRecorder().recorder, {
      ...silentLogger,
      error: (message) => void errors.push(message),
    });
    client.emit(Events.MessageUpdate, null, {
      id: ID,
      partial: true,
      guildId: GUILD,
      channelId: CHANNEL,
      fetch: async () => {
        throw new Error("socket");
      },
    });
    await settle();
    expect(errors).toEqual(["Archive event handling failed"]);
  });
});

describe("createChannelHistory", () => {
  const page = (messages: Message[], error?: unknown) => ({
    ...textChannel,
    guildId: GUILD,
    messages: {
      fetch: async () => {
        if (error) throw error;
        return new Map(messages.map((m) => [m.id, m]));
      },
    },
  });

  test("locates a channel and a thread under its parent; anything else is unknown", async () => {
    const history = createChannelHistory(
      fakeClient({ [CHANNEL]: page([]), [THREAD]: { ...thread, guildId: GUILD } }),
    );
    expect(await history.place(CHANNEL)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      parentId: null,
    });
    expect(await history.place(THREAD)).toEqual({
      guildId: GUILD,
      channelId: THREAD,
      parentId: CHANNEL,
    });
    expect(await history.place("200000000000000099")).toBeNull();
  });

  test("fetches one page without filling the cache and maps it", async () => {
    let seen: unknown;
    const channel = {
      ...page([]),
      messages: {
        fetch: async (options: unknown) => {
          seen = options;
          return new Map([["500000000000000001", fakeMessage()]]);
        },
      },
    };
    const history = createChannelHistory(fakeClient({ [CHANNEL]: channel }));
    const result = await history.page(CHANNEL, "500000000000000009", 100);
    expect(seen).toEqual({ before: "500000000000000009", limit: 100, cache: false });
    expect(result.ok && result.messages.map((m: ArchivedMessageInput) => m.id)).toEqual([
      "500000000000000001",
    ]);
  });

  test("missing access and an unknown channel are answers, other errors are thrown", async () => {
    const denied = page([], { code: RESTJSONErrorCodes.MissingAccess });
    expect(
      await createChannelHistory(fakeClient({ [CHANNEL]: denied })).page(CHANNEL, undefined, 100),
    ).toEqual({
      ok: false,
      reason: "no_access",
    });
    expect(await createChannelHistory(fakeClient()).page(CHANNEL, undefined, 100)).toEqual({
      ok: false,
      reason: "unknown_channel",
    });
    const broken = page([], new Error("socket"));
    await expect(
      createChannelHistory(fakeClient({ [CHANNEL]: broken })).page(CHANNEL, undefined, 100),
    ).rejects.toThrow("socket");
  });
});

describe("createGuildChannelList", () => {
  const channel = (
    id: string,
    name: string,
    type: ChannelType,
    rawPosition: number,
    parentId: string | null = null,
  ) => ({
    id,
    name,
    type,
    rawPosition,
    parentId,
    isThread: () =>
      type === ChannelType.PublicThread ||
      type === ChannelType.PrivateThread ||
      type === ChannelType.AnnouncementThread,
  });

  const clientWith = (channels: ReturnType<typeof channel>[]) =>
    ({
      guilds: {
        cache: new Map([[GUILD, { channels: { cache: new Map(channels.map((c) => [c.id, c])) } }]]),
      },
    }) as unknown as Client;

  test("lists message channels in Discord's order, threads after their channel", () => {
    const list = createGuildChannelList(
      clientWith([
        channel("9", "Kategoria B", ChannelType.GuildCategory, 1),
        channel("8", "Kategoria A", ChannelType.GuildCategory, 0),
        channel("1", "ogólny", ChannelType.GuildText, 0, "8"),
        channel("2", "głosowy", ChannelType.GuildVoice, 0, "9"),
        channel("3", "wątek", ChannelType.PublicThread, 0, "1"),
        channel("4", "ogłoszenia", ChannelType.GuildAnnouncement, 1, "8"),
        channel("5", "bez kategorii", ChannelType.GuildText, 5),
        channel("6", "forum", ChannelType.GuildForum, 2, "8"),
      ]),
    );
    expect(list(GUILD)).toEqual({
      channels: [
        { id: "5", name: "bez kategorii", kind: "text", parentId: null },
        { id: "1", name: "ogólny", kind: "text", parentId: "8" },
        { id: "3", name: "wątek", kind: "thread", parentId: "1" },
        { id: "4", name: "ogłoszenia", kind: "announcement", parentId: "8" },
        { id: "6", name: "forum", kind: "forum", parentId: "8" },
        { id: "2", name: "głosowy", kind: "voice", parentId: "9" },
      ],
      truncated: false,
    });
  });

  test("is null for a server the bot is not in", () => {
    expect(createGuildChannelList(clientWith([]))("100000000000000099")).toBeNull();
  });

  test("threads never crowd out channels", () => {
    const channels = Array.from({ length: MAX_CHANNELS - 2 }, (_, i) =>
      channel(String(1000 + i), `k${i}`, ChannelType.GuildText, i),
    );
    const threads = Array.from({ length: 10 }, (_, i) =>
      channel(String(5000 + i), `w${i}`, ChannelType.PublicThread, 0, "1000"),
    );
    const result = createGuildChannelList(clientWith([...threads, ...channels]))(GUILD);
    expect(result?.channels).toHaveLength(MAX_CHANNELS);
    expect(result?.channels.filter((c) => c.kind === "text")).toHaveLength(MAX_CHANNELS - 2);
    expect(result?.channels.slice(0, 3).map((c) => c.id)).toEqual(["1000", "5000", "5001"]);
    expect(result?.truncated).toBe(true);
  });

  test("stops at MAX_CHANNELS and says so", () => {
    const many = Array.from({ length: MAX_CHANNELS + 5 }, (_, i) =>
      channel(String(1000 + i), `k${i}`, ChannelType.GuildText, i),
    );
    const result = createGuildChannelList(clientWith(many))(GUILD);
    expect(result?.channels).toHaveLength(MAX_CHANNELS);
    expect(result?.truncated).toBe(true);
  });
});
