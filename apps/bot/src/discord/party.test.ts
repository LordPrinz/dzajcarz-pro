import { describe, expect, test } from "bun:test";
import { ChannelType, type Client, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import {
  createPartyChannels,
  createPartyChat,
  createPartyGuild,
  createPartyInvites,
  createPartyPermissions,
} from "./party.ts";

const GUILD = "100000000000000001";
const CHANNEL = "400000000000000004";
const EVERYONE = GUILD;

function bitsOf(...flags: bigint[]) {
  const value = flags.reduce((a, b) => a | b, 0n);
  return { has: (flag: bigint) => (value & flag) === flag };
}

interface FakeMember {
  channelId: string | null;
  permissions?: bigint[];
  disconnects: string[];
  bot?: boolean;
  /** Whether the member's own overwrite on the channel denies Connect. */
  blocked?: boolean;
}

function clientWith(member: FakeMember, parentOverwrite?: { allow: bigint[]; deny: bigint[] }) {
  const guildMember = {
    voice: {
      channelId: member.channelId,
      disconnect: async (reason: string) => void member.disconnects.push(reason),
    },
    permissions: { any: (flags: bigint[]) => flags.some((f) => member.permissions?.includes(f)) },
    user: { bot: member.bot ?? false },
  };
  const channel = {
    type: ChannelType.GuildVoice,
    guildId: GUILD,
    guild: { roles: { everyone: { id: EVERYONE } } },
    permissionOverwrites: {
      cache: new Map(
        member.blocked === undefined
          ? []
          : [["5", { deny: bitsOf(...(member.blocked ? [PermissionFlagsBits.Connect] : [])) }]],
      ),
    },
    parent: {
      permissionOverwrites: {
        cache: new Map(
          parentOverwrite
            ? [
                [
                  EVERYONE,
                  {
                    allow: bitsOf(...parentOverwrite.allow),
                    deny: bitsOf(...parentOverwrite.deny),
                  },
                ],
              ]
            : [],
        ),
      },
    },
    permissionsFor: () => bitsOf(...(member.permissions ?? [])),
  };
  return {
    user: { id: "bot" },
    channels: { fetch: async () => channel },
    guilds: { fetch: async () => ({ members: { fetch: async () => guildMember } }) },
  } as unknown as Client;
}

describe("party permissions adapter", () => {
  test("disconnect only pulls the member out of the given channel", async () => {
    const elsewhere: FakeMember = { channelId: "other", disconnects: [] };
    await createPartyPermissions(clientWith(elsewhere)).disconnect(GUILD, "5", CHANNEL, "why");
    expect(elsewhere.disconnects).toEqual([]);

    const inside: FakeMember = { channelId: CHANNEL, disconnects: [] };
    await createPartyPermissions(clientWith(inside)).disconnect(GUILD, "5", CHANNEL, "why");
    expect(inside.disconnects).toEqual(["why"]);
  });

  test("inheritedEveryone reads deny, allow and absence from the category", async () => {
    const member: FakeMember = { channelId: null, disconnects: [] };
    const read = (overwrite?: { allow: bigint[]; deny: bigint[] }) =>
      createPartyPermissions(clientWith(member, overwrite)).inheritedEveryone(CHANNEL);
    expect(await read()).toEqual({ connect: null, view: null });
    expect(
      await read({ allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }),
    ).toEqual({ connect: false, view: true });
  });

  test("lookupMember flags moderators", async () => {
    const lookup = (permissions: bigint[]) =>
      createPartyPermissions(
        clientWith({ channelId: null, permissions, disconnects: [] }),
      ).lookupMember(GUILD, "5");
    expect(await lookup([])).toEqual({ self: false, moderator: false, bot: false });
    expect(await lookup([PermissionFlagsBits.MoveMembers])).toEqual({
      self: false,
      moderator: true,
      bot: false,
    });
  });

  test("lookupMember tells bots apart", async () => {
    const lookup = (bot: boolean) =>
      createPartyPermissions(clientWith({ channelId: null, bot, disconnects: [] })).lookupMember(
        GUILD,
        "5",
      );
    expect((await lookup(true))?.bot).toBe(true);
    expect((await lookup(false))?.bot).toBe(false);
  });

  test("isBlocked reads the member's own overwrite for Connect", async () => {
    const blocked = (flag: boolean | undefined) =>
      createPartyPermissions(
        clientWith({ channelId: null, blocked: flag, disconnects: [] }),
      ).isBlocked(CHANNEL, "5");
    expect(await blocked(true)).toBe(true);
    expect(await blocked(false)).toBe(false);
    expect(await blocked(undefined)).toBe(false);
  });

  test("canManage asks the channel, overwrites included", async () => {
    const permissions = (flags: bigint[]) =>
      createPartyPermissions(clientWith({ channelId: null, permissions: flags, disconnects: [] }));
    expect(await permissions([]).canManage(GUILD, "5", CHANNEL)).toBe(false);
    expect(
      await permissions([PermissionFlagsBits.ManageChannels]).canManage(GUILD, "5", CHANNEL),
    ).toBe(true);
  });
});

describe("party invites adapter", () => {
  function clientWithUser(send: (payload: unknown) => Promise<void>) {
    return {
      channels: {
        fetch: async () => ({
          type: ChannelType.GuildVoice,
          name: "Kanał Ola",
          guild: { name: "Ekipa" },
        }),
      },
      users: {
        fetch: async () => ({
          send,
          username: "ola_k",
          displayAvatarURL: () => "https://cdn.discordapp.com/avatars/1/a.png",
        }),
      },
    } as unknown as Client;
  }

  test("describe names the channel, the server and the sender", async () => {
    const invites = createPartyInvites(clientWithUser(async () => {}));
    expect(await invites.describe(CHANNEL, "5")).toEqual({
      channelName: "Kanał Ola",
      guildName: "Ekipa",
      inviterUsername: "ola_k",
      inviterAvatarUrl: "https://cdn.discordapp.com/avatars/1/a.png",
    });
  });

  test("sendDirect uploads the files and maps the author", async () => {
    const sent: unknown[] = [];
    const invites = createPartyInvites(clientWithUser(async (payload) => void sent.push(payload)));
    await invites.sendDirect("5", {
      embeds: [
        {
          author: { name: "Zaproszenie od Ola", iconUrl: "https://cdn.discordapp.com/a.png" },
          footer: "stopka",
          image: "attachment://mapa.png",
        },
      ],
      files: [{ name: "mapa.png", data: new Uint8Array([1, 2]) }],
    });
    expect(sent[0]).toMatchObject({
      embeds: [
        {
          author: { name: "Zaproszenie od Ola", icon_url: "https://cdn.discordapp.com/a.png" },
          footer: { text: "stopka" },
          image: { url: "attachment://mapa.png" },
        },
      ],
      files: [{ attachment: Buffer.from([1, 2]), name: "mapa.png" }],
    });
  });

  test("downloadFile goes through the Discord-only downloader", async () => {
    const asked: string[] = [];
    const fetchFile = (async (url: string) => {
      asked.push(url);
      return new Response(new Uint8Array([7]));
    }) as unknown as typeof fetch;
    const invites = createPartyInvites(
      clientWithUser(async () => {}),
      fetchFile,
    );
    expect(await invites.downloadFile("https://cdn.discordapp.com/a.png", 5)).toEqual(
      new Uint8Array([7]),
    );
    expect(await invites.downloadFile("https://evil.example/a.png", 5)).toBeNull();
    expect(asked).toEqual(["https://cdn.discordapp.com/a.png"]);
  });

  test("sendDirect sends the embed and link button without mentions", async () => {
    const sent: unknown[] = [];
    const invites = createPartyInvites(clientWithUser(async (payload) => void sent.push(payload)));
    const result = await invites.sendDirect("5", {
      embeds: [{ title: "Hej", image: "https://cdn.discordapp.com/a.png" }],
      components: [[{ type: "link", label: "Dołącz", url: "https://discord.com/channels/1/2" }]],
    });
    expect(result).toBe(true);
    expect(sent[0]).toMatchObject({
      embeds: [{ title: "Hej", image: { url: "https://cdn.discordapp.com/a.png" } }],
      components: [{ components: [{ url: "https://discord.com/channels/1/2", label: "Dołącz" }] }],
      allowedMentions: { parse: [] },
    });
  });

  test("closed DMs give false, other failures are thrown", async () => {
    const closed = createPartyInvites(
      clientWithUser(async () => {
        throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
      }),
    );
    expect(await closed.sendDirect("5", "hej")).toBe(false);
    const broken = createPartyInvites(
      clientWithUser(async () => {
        throw Object.assign(new Error("Server error"), { code: 0 });
      }),
    );
    await expect(broken.sendDirect("5", "hej")).rejects.toThrow("Server error");
  });
});

describe("party chat adapter", () => {
  const NOW = Date.UTC(2026, 5, 1);
  const DAY = 86_400_000;
  /** A message id whose creation time is `ageMs` before NOW. */
  const idAged = (ageMs: number, salt = 0) =>
    ((BigInt(NOW - ageMs - 1_420_070_400_000) << 22n) + BigInt(salt)).toString();

  const discordError = (code: number) => Object.assign(new Error(`Discord ${code}`), { code });

  interface FakeChatOptions {
    /** Ids Discord reports as unknown, per call kind. */
    gone?: string[];
    bulkError?: number;
    systemIds?: string[];
    existsError?: Error;
  }

  function fakeChat({ gone = [], bulkError, systemIds = [], existsError }: FakeChatOptions = {}) {
    const bulk: string[][] = [];
    const single: string[] = [];
    const deleted = new Set<string>();
    const channel = {
      isTextBased: () => true,
      bulkDelete: async (ids: string[]) => {
        bulk.push(ids);
        if (bulkError) throw discordError(bulkError);
        for (const id of ids) deleted.add(id);
        return new Map(ids.map((id) => [id, {}]));
      },
      messages: {
        delete: async (id: string) => {
          single.push(id);
          if (deleted.has(id) || gone.includes(id)) throw discordError(10008);
          if (systemIds.includes(id)) throw discordError(50021);
          deleted.add(id);
        },
        fetch: async (options: unknown) => {
          if (existsError) throw existsError;
          if (typeof options === "object" && options !== null && "message" in options) {
            if (gone.includes(String(options.message))) throw discordError(10008);
            return {};
          }
          return new Map();
        },
      },
    };
    const client = { channels: { fetch: async () => channel } } as unknown as Client;
    return { chat: createPartyChat(client, () => NOW), bulk, single, deleted };
  }

  test("recent messages go in one bulk delete, old ones one by one", async () => {
    const recent = [idAged(DAY, 1), idAged(2 * DAY, 2), idAged(3 * DAY, 3)];
    const old = [idAged(15 * DAY, 4), idAged(40 * DAY, 5)];
    const { chat, bulk, single } = fakeChat();
    await chat.deleteMessages(CHANNEL, [...old, ...recent]);
    expect(bulk).toEqual([recent]);
    expect(single).toEqual(old);
  });

  test("a lone recent message is a single delete, not a bulk call", async () => {
    const only = idAged(DAY);
    const { chat, bulk, single } = fakeChat();
    await chat.deleteMessages(CHANNEL, [only, idAged(30 * DAY)]);
    expect(bulk).toEqual([]);
    expect(single).toContain(only);
  });

  test("a message just under 14 days old is not trusted to bulk delete", async () => {
    const edge = [idAged(14 * DAY - 30_000, 1), idAged(DAY, 2)];
    const { chat, bulk, single } = fakeChat();
    await chat.deleteMessages(CHANNEL, edge);
    expect(bulk).toEqual([]);
    expect(single.sort()).toEqual([...edge].sort());
  });

  test("more than 100 recent messages are split into batches", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => idAged(DAY, i));
    const { chat, bulk, single } = fakeChat();
    await chat.deleteMessages(CHANNEL, ids);
    expect(bulk.map((batch) => batch.length)).toEqual([100, 100]);
    expect(single).toEqual([ids[200] ?? ""]);
  });

  test("a bulk delete refused as a whole falls back to single deletes, each once", async () => {
    for (const code of [10008, 50021, 50034]) {
      const ids = [idAged(DAY, 1), idAged(DAY, 2)];
      const { chat, bulk, single } = fakeChat({ bulkError: code });
      await chat.deleteMessages(CHANNEL, ids);
      expect(bulk).toHaveLength(1);
      expect(single).toEqual(ids);
    }
  });

  test("other bulk errors are thrown", async () => {
    const { chat } = fakeChat({ bulkError: 50013 });
    await expect(chat.deleteMessages(CHANNEL, [idAged(DAY, 1), idAged(DAY, 2)])).rejects.toThrow();
  });

  test("a message that is already gone, or a system message, is skipped quietly", async () => {
    const gone = idAged(30 * DAY, 1);
    const system = idAged(30 * DAY, 2);
    const { chat, deleted } = fakeChat({ gone: [gone], systemIds: [system] });
    await chat.deleteMessages(CHANNEL, [gone, system, idAged(30 * DAY, 3)]);
    expect(deleted.size).toBe(1);
  });

  test("a refusal other than unknown or system is thrown", async () => {
    const client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            delete: async () => {
              throw discordError(50013);
            },
          },
        }),
      },
    } as unknown as Client;
    await expect(
      createPartyChat(client, () => NOW).deleteMessages(CHANNEL, [idAged(30 * DAY)]),
    ).rejects.toThrow();
  });

  test("exists is false on Unknown Message and throws on anything else", async () => {
    const id = idAged(DAY);
    expect(await fakeChat({ gone: [id] }).chat.exists(CHANNEL, id)).toBe(false);
    expect(await fakeChat().chat.exists(CHANNEL, id)).toBe(true);
    const failing = fakeChat({ existsError: discordError(50001) }).chat;
    await expect(failing.exists(CHANNEL, id)).rejects.toThrow();
  });

  test("recentMessages reports the pinned and system flags", async () => {
    const client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () =>
              new Map([
                ["2", { id: "2", author: { id: "u2" }, pinned: true, system: false }],
                ["1", { id: "1", author: { id: "u1" }, pinned: false, system: true }],
              ]),
          },
        }),
      },
    } as unknown as Client;
    expect(await createPartyChat(client).recentMessages(CHANNEL)).toEqual([
      { id: "2", authorId: "u2", pinned: true, system: false },
      { id: "1", authorId: "u1", pinned: false, system: true },
    ]);
  });

  test("selfId is the client user's id, or undefined before login", () => {
    expect(createPartyChat({ user: { id: "bot" } } as unknown as Client).selfId()).toBe("bot");
    expect(createPartyChat({ user: null } as unknown as Client).selfId()).toBeUndefined();
  });
});

describe("party channels adapter", () => {
  function clientWithVoice(available: boolean) {
    const members = new Map([
      ["7", { id: "7", user: { bot: false } }],
      ["8", { id: "8", user: { bot: true } }],
    ]);
    const channel = {
      type: ChannelType.GuildVoice,
      guild: { available },
      members: { filter: (keep: (m: unknown) => boolean) => [...members.values()].filter(keep) },
    };
    return { channels: { fetch: async () => channel } } as unknown as Client;
  }

  test("members lists people without bots", async () => {
    expect(await createPartyChannels(clientWithVoice(true)).members("1")).toEqual(["7"]);
  });

  test("members is unknown while the guild is unavailable, so nobody reads it as empty", async () => {
    expect(await createPartyChannels(clientWithVoice(false)).members("1")).toBeUndefined();
  });
});

describe("party guild adapter", () => {
  const clientWithMember = (fetch: () => Promise<unknown>) =>
    ({ guilds: { fetch: async () => ({ members: { fetch } }) } }) as unknown as Client;

  test("the guild owner holds every bit although their roles lack Manage Channels", async () => {
    // discord.js answers `member.permissions` for the owner with all bits, whatever the roles grant.
    const roleBits = 1n << 10n;
    const owner = {
      id: "9",
      get permissions() {
        return { bitfield: this.id === "9" ? PermissionsBitField.All : roleBits };
      },
    };
    const guild = createPartyGuild(clientWithMember(async () => owner));
    const bits = await guild.memberPermissions(GUILD, "9");
    expect(bits & PermissionFlagsBits.ManageChannels).toBe(PermissionFlagsBits.ManageChannels);
  });

  test("memberPermissions returns the role bits, and 0 for someone who left", async () => {
    const present = createPartyGuild(
      clientWithMember(async () => ({ permissions: { bitfield: 16n } })),
    );
    expect(await present.memberPermissions(GUILD, "5")).toBe(16n);
    const gone = createPartyGuild(
      clientWithMember(async () => {
        throw Object.assign(new Error("Unknown Member"), { code: 10007 });
      }),
    );
    expect(await gone.memberPermissions(GUILD, "5")).toBe(0n);
  });
});
