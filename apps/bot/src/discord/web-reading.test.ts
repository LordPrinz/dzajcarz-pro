import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { silentLogger } from "@dzajcarz/core";
import {
  COMMANDS,
  EVENTS,
  type EventName,
  type EventPayload,
  jsonBytes,
  MAX_DM_CHANNELS,
  MAX_MESSAGE_BYTES,
} from "@dzajcarz/web-protocol";
import { ChannelType, type Client, Events, type Message, RESTJSONErrorCodes } from "discord.js";
import {
  attachMessageEvents,
  createChannelReader,
  createDmList,
  createNameResolver,
  type ResolveNames,
} from "./web-reading.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const OLA = "300000000000000003";
const JAN = "300000000000000004";
const ROLE = "400000000000000004";
const id = (n: number) => String(500000000000000000n + BigInt(n));

function fakeMessage(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    guildId: GUILD,
    channelId: CHANNEL,
    partial: false,
    author: {
      id: OLA,
      username: "ola",
      globalName: null,
      bot: false,
      displayAvatarURL: () => "https://cdn.discordapp.com/avatars/3/a.png",
    },
    member: null,
    content: `hej <@${JAN}>`,
    attachments: { map: () => [] },
    embeds: [],
    reference: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 10, n)),
    createdTimestamp: Date.UTC(2026, 10, 1, 10, n),
    editedAt: null,
    ...overrides,
  } as unknown as Message;
}

const discordError = (code: number) => Object.assign(new Error("discord"), { code });

function fakeClient({
  channels = new Map<string, unknown>(),
  fetchChannel,
}: {
  channels?: Map<string, unknown>;
  fetchChannel?: (id: string) => Promise<unknown>;
} = {}) {
  const emitter = new EventEmitter();
  const guild = {
    members: { cache: new Map([[JAN, { displayName: "Jan na serwerze", user: {} }]]) },
    roles: {
      cache: new Map([[ROLE, { name: "Admini", colors: { primaryColor: 0xff0000 } }]]),
    },
  };
  return Object.assign(emitter, {
    guilds: { cache: new Map([[GUILD, guild]]) },
    users: {
      cache: new Map([[OLA, { username: "ola", globalName: "Ola" }]]),
    },
    channels: {
      cache: channels,
      fetch: fetchChannel ?? (async (key: string) => channels.get(key) ?? null),
    },
  }) as unknown as Client;
}

describe("createNameResolver", () => {
  test("names members, users, roles and channels from the caches and skips unknown ids", async () => {
    const client = fakeClient({
      channels: new Map([
        [CHANNEL, { name: "ogólny" }],
        [id(1), { type: ChannelType.DM }],
      ]),
    });
    expect(
      await createNameResolver(client)({
        guildId: GUILD,
        users: [JAN, OLA, id(9)],
        roles: [ROLE, id(8)],
        channels: [CHANNEL, id(1)],
      }),
    ).toEqual({
      users: { [JAN]: "Jan na serwerze", [OLA]: "Ola" },
      roles: { [ROLE]: { name: "Admini", color: 0xff0000 } },
      channels: { [CHANNEL]: "ogólny" },
    });
  });

  test("in a DM there are no roles and no members", async () => {
    const resolved = await createNameResolver(fakeClient())({
      guildId: null,
      users: [JAN, OLA],
      roles: [ROLE],
      channels: [],
    });
    expect(resolved).toEqual({ users: { [OLA]: "Ola" }, roles: {}, channels: {} });
  });
});

const noNames: ResolveNames = async () => ({ users: {}, roles: {}, channels: {} });

function textChannel(fetch: (options: unknown) => Promise<Map<string, Message>>) {
  return { id: CHANNEL, guildId: GUILD, isTextBased: () => true, messages: { fetch } };
}

describe("createChannelReader", () => {
  test("returns the page oldest first, with names, and asks Discord not to cache it", async () => {
    let asked: unknown;
    const channel = textChannel(async (options) => {
      asked = options;
      return new Map([
        [id(2), fakeMessage(2)],
        [id(1), fakeMessage(1)],
      ]);
    });
    const read = createChannelReader(
      fakeClient({ channels: new Map([[CHANNEL, channel]]) }),
      createNameResolver(fakeClient()),
    );
    const result = await read({ channelId: CHANNEL, before: id(3), limit: 2 });
    expect(asked).toEqual({ before: id(3), limit: 2, cache: false });
    expect(COMMANDS["channel.messages"].response.parse(result)).toMatchObject({
      status: "ok",
      messages: [{ id: id(1) }, { id: id(2) }],
      resolved: { users: { [JAN]: "Jan na serwerze" } },
      hasMore: true,
    });
  });

  test("a short page means the start of the channel", async () => {
    const channel = textChannel(async () => new Map([[id(1), fakeMessage(1)]]));
    const read = createChannelReader(
      fakeClient({ channels: new Map([[CHANNEL, channel]]) }),
      noNames,
    );
    expect(await read({ channelId: CHANNEL, limit: 50 })).toMatchObject({ hasMore: false });
  });

  test("a page of huge messages is cut to fit in one reply", async () => {
    const huge = (n: number) =>
      fakeMessage(n, {
        content: "\u0001".repeat(4000),
        embeds: [{ toJSON: () => ({ description: "\u0001".repeat(4096) }) }],
      });
    const channel = textChannel(
      async () => new Map(Array.from({ length: 50 }, (_, i) => [id(i), huge(i)])),
    );
    const read = createChannelReader(
      fakeClient({ channels: new Map([[CHANNEL, channel]]) }),
      noNames,
    );
    const result = await read({ channelId: CHANNEL, limit: 50 });
    const reply = { v: 1, id: crypto.randomUUID(), ok: true, result };
    expect(jsonBytes(reply)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(result).toMatchObject({ status: "ok", hasMore: true });
    if (result.status === "ok") expect(result.messages.at(-1)?.id).toBe(id(49));
  });

  test("tells an unknown channel, a non-text one and a missing permission apart", async () => {
    const forum = { id: CHANNEL, isTextBased: () => false };
    const denied = textChannel(async () => {
      throw discordError(RESTJSONErrorCodes.MissingAccess);
    });
    const gone = textChannel(async () => {
      throw discordError(RESTJSONErrorCodes.UnknownChannel);
    });
    const broken = textChannel(async () => {
      throw new Error("network");
    });
    const reader = (channel: unknown) =>
      createChannelReader(
        fakeClient({
          fetchChannel: async () => {
            if (channel === undefined) throw discordError(RESTJSONErrorCodes.UnknownChannel);
            return channel;
          },
        }),
        noNames,
      );
    const request = { channelId: CHANNEL, limit: 10 };
    expect(await reader(undefined)(request)).toEqual({ status: "unknown_channel" });
    expect(await reader(forum)(request)).toEqual({ status: "unknown_channel" });
    expect(await reader(denied)(request)).toEqual({ status: "no_access" });
    expect(await reader(gone)(request)).toEqual({ status: "unknown_channel" });
    await expect(reader(broken)(request)).rejects.toThrow("network");
  });
});

describe("createDmList", () => {
  const dm = (n: number, last: string | null, recipient: unknown = null) => ({
    id: id(n),
    type: ChannelType.DM,
    lastMessageId: last,
    recipient,
  });
  const user = {
    id: OLA,
    username: "ola",
    globalName: "Ola",
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/3/a.png",
  };

  test("lists cached DM channels, most recent first, without guild channels", async () => {
    const channels = new Map<string, unknown>([
      [id(1), dm(1, "900000000000000001", user)],
      [id(2), dm(2, "1000000000000000002")],
      [id(3), dm(3, null)],
      [CHANNEL, { id: CHANNEL, type: ChannelType.GuildText }],
    ]);
    const result = await createDmList(fakeClient({ channels }))();
    expect(COMMANDS["dms.list"].response.parse(result)).toEqual({
      channels: [
        { channelId: id(2), recipient: null, lastMessageId: "1000000000000000002" },
        {
          channelId: id(1),
          recipient: {
            id: OLA,
            username: "ola",
            displayName: "Ola",
            avatarUrl: "https://cdn.discordapp.com/avatars/3/a.png",
          },
          lastMessageId: "900000000000000001",
        },
        { channelId: id(3), recipient: null, lastMessageId: null },
      ],
      truncated: false,
    });
  });

  test("caps the list", async () => {
    const channels = new Map<string, unknown>(
      Array.from({ length: MAX_DM_CHANNELS + 5 }, (_, i) => [id(i), dm(i, id(i))]),
    );
    const result = await createDmList(fakeClient({ channels }))();
    expect(result.channels).toHaveLength(MAX_DM_CHANNELS);
    expect(result.truncated).toBe(true);
    expect(result.channels[0]?.channelId).toBe(id(MAX_DM_CHANNELS + 4));
  });
});

describe("attachMessageEvents", () => {
  function setup(logger = silentLogger) {
    const client = fakeClient();
    const published: { name: EventName; payload: unknown }[] = [];
    attachMessageEvents(client, {
      publish: async <N extends EventName>(name: N, payload: EventPayload<N>) => {
        expect(EVENTS[name].safeParse(payload).success).toBe(true);
        published.push({ name, payload });
      },
      resolve: createNameResolver(client),
      logger,
    });
    const emit = async (event: string, ...args: unknown[]) => {
      client.emit(event, ...args);
      await Bun.sleep(1);
    };
    return { published, emit };
  }

  test("a new message goes out with its names", async () => {
    const { published, emit } = setup();
    await emit(Events.MessageCreate, fakeMessage(1));
    expect(published).toEqual([
      {
        name: "message.created",
        payload: {
          message: expect.objectContaining({ id: id(1), content: `hej <@${JAN}>` }),
          resolved: { users: { [JAN]: "Jan na serwerze" }, roles: {}, channels: {} },
        },
      },
    ]);
  });

  test("an edit goes out; a partial one is skipped without a call to Discord", async () => {
    const { published, emit } = setup();
    let fetched = 0;
    await emit(Events.MessageUpdate, null, fakeMessage(1, { content: "nowa" }));
    await emit(Events.MessageUpdate, null, {
      partial: true,
      fetch: async () => {
        fetched += 1;
        return fakeMessage(2);
      },
    });
    expect(
      published.map((p) => [p.name, (p.payload as { message: Message }).message.content]),
    ).toEqual([["message.updated", "nowa"]]);
    expect(fetched).toBe(0);
  });

  test("deletes go out as ids, a bulk delete in chunks of 100", async () => {
    const { published, emit } = setup();
    await emit(Events.MessageDelete, { id: id(1), guildId: GUILD, channelId: CHANNEL });
    const many = new Map(Array.from({ length: 150 }, (_, i) => [id(i), {}]));
    await emit(Events.MessageBulkDelete, many, { id: CHANNEL, guildId: GUILD });
    expect(published.map((p) => (p.payload as { ids: string[] }).ids.length)).toEqual([1, 100, 50]);
    expect(published[0]).toEqual({
      name: "message.deleted",
      payload: { guildId: GUILD, channelId: CHANNEL, ids: [id(1)] },
    });
  });

  test("a failure is logged and goes no further", async () => {
    const errors: string[] = [];
    const { published, emit } = setup({
      ...silentLogger,
      error: (message: string) => void errors.push(message),
    });
    await emit(
      Events.MessageCreate,
      fakeMessage(1, {
        author: {
          ...fakeMessage(1).author,
          displayAvatarURL: () => {
            throw new Error("broken");
          },
        },
      }),
    );
    expect(published).toEqual([]);
    expect(errors).toEqual(["Publishing a message event failed"]);
  });
});
