import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { ClaimResult, StagedUpload } from "@dzajcarz/db";
import {
  COMMANDS,
  DEFAULT_UPLOAD_LIMIT,
  MAX_UPLOAD_BYTES,
  type WriteRejection,
} from "@dzajcarz/web-protocol";
import {
  type Client,
  GuildPremiumTier,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
} from "discord.js";
import {
  createWriting,
  panelMentions,
  reactionIdentifier,
  SEARCH_CONCURRENCY,
  uploadLimit,
} from "./web-writing.ts";

const BOT = "300000000000000001";
const OLA = "300000000000000002";
const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const MESSAGE = "500000000000000001";
const MIB = 1024 * 1024;

const discordError = (code: number) => Object.assign(new Error("discord"), { code });

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ManageMessages,
];

interface FakeMessageOptions {
  author?: string;
  edit?: () => Promise<unknown>;
  delete?: () => Promise<unknown>;
}

function fakeMessage({ author = BOT, ...calls }: FakeMessageOptions = {}) {
  const seen: { edit: unknown[]; deleted: number } = { edit: [], deleted: 0 };
  return {
    seen,
    message: {
      id: MESSAGE,
      author: { id: author },
      edit: async (options: unknown) => {
        seen.edit.push(options);
        return calls.edit ? calls.edit() : {};
      },
      delete: async () => {
        seen.deleted++;
        return calls.delete ? calls.delete() : {};
      },
    },
  };
}

interface ChannelOptions {
  dm?: boolean;
  thread?: boolean;
  permissions?: bigint[] | null;
  premiumTier?: GuildPremiumTier;
  send?: (options: Record<string, unknown>) => Promise<unknown>;
  fetchMessage?: () => Promise<unknown>;
}

function fakeChannel({
  dm = false,
  thread = false,
  permissions = ALL,
  premiumTier = GuildPremiumTier.None,
  send,
  fetchMessage,
}: ChannelOptions = {}) {
  const sent: Record<string, unknown>[] = [];
  const channel = {
    id: CHANNEL,
    guildId: dm ? null : GUILD,
    guild: dm ? null : { id: GUILD, premiumTier },
    isSendable: () => true,
    isDMBased: () => dm,
    isThread: () => thread,
    permissionsFor: (userId: string) =>
      userId === BOT && permissions ? { has: (flag: bigint) => permissions.includes(flag) } : null,
    send: async (options: Record<string, unknown>) => {
      sent.push(options);
      return send ? send(options) : { id: "500000000000000099" };
    },
    messages: {
      fetch: fetchMessage ?? (async () => fakeMessage().message),
    },
  };
  return { channel, sent };
}

function fakeClient({
  channel,
  rest = {},
  users = {},
  guilds = new Map(),
}: {
  channel?: unknown;
  rest?: Partial<Record<"put" | "delete", (route: string) => Promise<unknown>>>;
  users?: { fetch?: (id: string) => Promise<unknown> };
  guilds?: Map<string, unknown>;
} = {}) {
  const calls: [string, string][] = [];
  const client = {
    user: { id: BOT },
    channels: { fetch: async (id: string) => (id === CHANNEL ? (channel ?? null) : null) },
    rest: {
      put: async (route: string) => {
        calls.push(["put", route]);
        return rest.put?.(route);
      },
      delete: async (route: string) => {
        calls.push(["delete", route]);
        return rest.delete?.(route);
      },
    },
    users: { fetch: users.fetch ?? (async () => null) },
    guilds: { cache: guilds },
  } as unknown as Client;
  return { client, calls };
}

/** Staged files the way the store hands them out: the bytes only to a claim, a sent file only to its nonce. */
function fakeUploads(stored: StagedUpload[] = []) {
  const sentWith = new Map<string, string>();
  let bytesRead = 0;
  return {
    sentWith,
    bytesRead: () => bytesRead,
    uploads: {
      sizes: async (ids: readonly string[]) =>
        stored.filter((file) => ids.includes(file.id)).map(({ id, size }) => ({ id, size })),
      claim: async <T>(
        ids: readonly string[],
        nonce: string,
        send: (files: StagedUpload[]) => Promise<T>,
        sent: (value: T) => boolean,
      ): Promise<ClaimResult<T>> => {
        const files = ids.flatMap((id) => stored.filter((file) => file.id === id));
        if (files.length !== ids.length) return { status: "missing" };
        if (files.some((file) => (sentWith.get(file.id) ?? nonce) !== nonce)) {
          return { status: "taken" };
        }
        bytesRead += files.length;
        const value = await send(files);
        if (sent(value)) for (const file of files) sentWith.set(file.id, nonce);
        return { status: "ok", value };
      },
    },
  };
}

const upload = (size: number, name = "plik.txt"): StagedUpload => ({
  id: crypto.randomUUID(),
  name,
  size,
  data: Buffer.alloc(Math.min(size, 16)),
});

function writing(options: {
  channel?: unknown;
  uploads?: ReturnType<typeof fakeUploads>["uploads"];
  rest?: NonNullable<Parameters<typeof fakeClient>[0]>["rest"];
  users?: NonNullable<Parameters<typeof fakeClient>[0]>["users"];
  guilds?: Map<string, unknown>;
}) {
  const { client, calls } = fakeClient(options);
  return {
    calls,
    handlers: createWriting({
      client,
      uploads: options.uploads ?? fakeUploads().uploads,
      logger: silentLogger,
    }),
  };
}

const deadline = { deadline: Date.now() + 5_000 };
const send = (overrides: Record<string, unknown> = {}) =>
  COMMANDS["message.send"].request.parse({
    channelId: CHANNEL,
    content: "hej <@300000000000000002> @everyone",
    allowMentions: false,
    nonce: "abc",
    ...overrides,
  });

describe("panelMentions (ADR 10)", () => {
  test("off: nothing pings", () => {
    expect(panelMentions(false)).toEqual({ parse: [], repliedUser: false });
  });

  test("on: users and roles, never everyone, and a reply does not ping its author", () => {
    expect(panelMentions(true)).toEqual({ parse: ["users", "roles"], repliedUser: false });
  });
});

describe("uploadLimit", () => {
  test.each([
    [null, DEFAULT_UPLOAD_LIMIT],
    [{ premiumTier: GuildPremiumTier.None }, DEFAULT_UPLOAD_LIMIT],
    [{ premiumTier: GuildPremiumTier.Tier1 }, DEFAULT_UPLOAD_LIMIT],
    // The panel's own ceiling caps boosted servers.
    [{ premiumTier: GuildPremiumTier.Tier2 }, MAX_UPLOAD_BYTES],
    [{ premiumTier: GuildPremiumTier.Tier3 }, MAX_UPLOAD_BYTES],
  ])("%j -> %d", (guild, limit) => {
    expect(uploadLimit(guild)).toBe(limit);
  });
});

describe("reactionIdentifier", () => {
  test("encodes a unicode emoji and keeps a custom one", () => {
    expect(reactionIdentifier("👍")).toBe("%F0%9F%91%8D");
    expect(reactionIdentifier("dzajco:123456789012345678")).toBe("dzajco:123456789012345678");
    expect(reactionIdentifier("a:taniec:123456789012345678")).toBe("a:taniec:123456789012345678");
  });
});

describe("channel.info", () => {
  test("a server channel: its upload limit and what the bot may do", async () => {
    const { channel } = fakeChannel({
      premiumTier: GuildPremiumTier.Tier2,
      permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
    expect(
      await writing({ channel }).handlers["channel.info"]({ channelId: CHANNEL }, deadline),
    ).toEqual({
      status: "ok",
      guildId: GUILD,
      botUserId: BOT,
      uploadLimit: MAX_UPLOAD_BYTES,
      can: { send: true, attach: false, history: false, react: false, manage: false },
    });
  });

  test("a DM: everything but deleting the other side's messages", async () => {
    const { channel } = fakeChannel({ dm: true, permissions: null });
    expect(
      await writing({ channel }).handlers["channel.info"]({ channelId: CHANNEL }, deadline),
    ).toMatchObject({
      guildId: null,
      uploadLimit: DEFAULT_UPLOAD_LIMIT,
      can: { send: true, attach: true, history: true, react: true, manage: false },
    });
  });

  test("a thread needs Send Messages in Threads, not Send Messages", async () => {
    const { channel } = fakeChannel({
      thread: true,
      permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
    const info = await writing({ channel }).handlers["channel.info"](
      { channelId: CHANNEL },
      deadline,
    );
    expect(info).toMatchObject({ can: { send: false } });
  });

  test("a channel the bot cannot see", async () => {
    expect(await writing({}).handlers["channel.info"]({ channelId: CHANNEL }, deadline)).toEqual({
      status: "unknown_channel",
    });
  });
});

describe("message.send", () => {
  test("sends with the mention policy, a nonce Discord enforces, and no pings by default", async () => {
    const { channel, sent } = fakeChannel();
    const result = await writing({ channel }).handlers["message.send"](send(), deadline);
    expect(result).toEqual({ status: "ok", messageId: "500000000000000099" });
    expect(sent).toEqual([
      {
        content: "hej <@300000000000000002> @everyone",
        files: [],
        reply: undefined,
        allowedMentions: { parse: [], repliedUser: false },
        nonce: "abc",
        enforceNonce: true,
      },
    ]);
  });

  test("with the switch on, users and roles may ping; a reply references its message", async () => {
    const { channel, sent } = fakeChannel();
    await writing({ channel }).handlers["message.send"](
      send({ allowMentions: true, replyTo: MESSAGE }),
      deadline,
    );
    expect(sent[0]).toMatchObject({
      allowedMentions: { parse: ["users", "roles"], repliedUser: false },
      reply: { messageReference: MESSAGE, failIfNotExists: true },
    });
  });

  test.each([
    ["no View Channel", [PermissionFlagsBits.SendMessages], {}, "no_send"],
    ["no Send Messages", [PermissionFlagsBits.ViewChannel], {}, "no_send"],
    [
      "a reply without Read Message History",
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      { replyTo: MESSAGE },
      "no_history",
    ],
    [
      "a file without Attach Files",
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      { attachmentIds: [crypto.randomUUID()] },
      "no_attach",
    ],
  ] satisfies [string, bigint[], Record<string, unknown>, WriteRejection][])(
    "%s: rejected, nothing sent",
    async (_label, permissions, overrides, reason) => {
      const { channel, sent } = fakeChannel({ permissions });
      expect(
        await writing({ channel }).handlers["message.send"](send(overrides), deadline),
      ).toEqual({ status: "rejected", reason });
      expect(sent).toEqual([]);
    },
  );

  test("an unknown channel is rejected", async () => {
    expect(await writing({}).handlers["message.send"](send(), deadline)).toEqual({
      status: "rejected",
      reason: "unknown_channel",
    });
  });

  test("files are sent by name and marked with the message's nonce", async () => {
    const files = [upload(100, "a.png"), upload(200, "b.txt")];
    const { uploads, sentWith } = fakeUploads(files);
    const { channel, sent } = fakeChannel();
    const result = await writing({ channel, uploads }).handlers["message.send"](
      send({ content: "", attachmentIds: files.map((file) => file.id) }),
      deadline,
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(sent[0]?.content).toBeUndefined();
    expect(sent[0]?.files).toEqual(
      files.map((file) => ({ attachment: file.data, name: file.name })),
    );
    expect([...sentWith.values()]).toEqual(["abc", "abc"]);
  });

  test("a retry after a send whose answer was lost reaches Discord again with the same nonce", async () => {
    const file = upload(10);
    const { uploads } = fakeUploads([file]);
    const { channel, sent } = fakeChannel();
    const handlers = writing({ channel, uploads }).handlers;
    const request = send({ attachmentIds: [file.id] });
    expect(await handlers["message.send"](request, deadline)).toMatchObject({ status: "ok" });
    // The panel timed out and the owner sends the same draft again: same files, same nonce. Discord
    // answers that nonce with the message it already created, so nothing is posted twice.
    expect(await handlers["message.send"](request, deadline)).toMatchObject({ status: "ok" });
    expect(sent.map((options) => [options.nonce, options.enforceNonce])).toEqual([
      ["abc", true],
      ["abc", true],
    ]);
    // Another message cannot take the files of a sent one.
    expect(
      await handlers["message.send"](send({ attachmentIds: [file.id], nonce: "other" }), deadline),
    ).toEqual({ status: "rejected", reason: "upload_missing" });
  });

  test("a file over the target's limit sends nothing and its bytes are never loaded", async () => {
    const big = upload(DEFAULT_UPLOAD_LIMIT + 1);
    const { uploads, bytesRead } = fakeUploads([big]);
    const { channel, sent } = fakeChannel();
    expect(
      await writing({ channel, uploads }).handlers["message.send"](
        send({ attachmentIds: [big.id] }),
        deadline,
      ),
    ).toEqual({ status: "rejected", reason: "file_too_large" });
    expect(sent).toEqual([]);
    expect(bytesRead()).toBe(0);
  });

  test("files that fit one by one but not together are refused", async () => {
    const files = [upload(6 * MIB), upload(6 * MIB)];
    const { uploads } = fakeUploads(files);
    const { channel, sent } = fakeChannel();
    expect(
      await writing({ channel, uploads }).handlers["message.send"](
        send({ attachmentIds: files.map((file) => file.id) }),
        deadline,
      ),
    ).toEqual({ status: "rejected", reason: "file_too_large" });
    expect(sent).toEqual([]);
  });

  test("a reply to a message that is gone is unknown_message", async () => {
    const { channel } = fakeChannel({
      send: async () => {
        throw Object.assign(discordError(RESTJSONErrorCodes.InvalidFormBodyOrContentType), {
          rawError: {
            errors: {
              message_reference: { _errors: [{ code: "MESSAGE_REFERENCE_UNKNOWN_MESSAGE" }] },
            },
          },
        });
      },
    });
    expect(
      await writing({ channel }).handlers["message.send"](send({ replyTo: MESSAGE }), deadline),
    ).toEqual({ status: "rejected", reason: "unknown_message" });
  });

  test("another invalid form body is a failure, not a lost reply", async () => {
    const { channel } = fakeChannel({
      send: async () => {
        throw Object.assign(discordError(RESTJSONErrorCodes.InvalidFormBodyOrContentType), {
          rawError: { errors: { content: {} } },
        });
      },
    });
    await expect(writing({ channel }).handlers["message.send"](send(), deadline)).rejects.toThrow();
  });

  test("a boosted server takes a bigger file, up to the panel's ceiling for all of them", async () => {
    const files = [upload(20 * MIB), upload(6 * MIB)];
    const { uploads } = fakeUploads(files);
    const { channel, sent } = fakeChannel({ premiumTier: GuildPremiumTier.Tier3 });
    const handlers = writing({ channel, uploads }).handlers;
    expect(
      await handlers["message.send"](send({ attachmentIds: [files[0]?.id] }), deadline),
    ).toMatchObject({ status: "ok" });
    expect(
      await handlers["message.send"](send({ attachmentIds: files.map((f) => f.id) }), deadline),
    ).toEqual({ status: "rejected", reason: "file_too_large" });
    expect(sent).toHaveLength(1);
  });

  test("a file named twice is sent once", async () => {
    const file = upload(10);
    const { uploads } = fakeUploads([file]);
    const { channel, sent } = fakeChannel();
    await writing({ channel, uploads }).handlers["message.send"](
      send({ attachmentIds: [file.id, file.id] }),
      deadline,
    );
    expect(sent[0]?.files).toHaveLength(1);
  });

  test("a missing or expired upload sends nothing", async () => {
    const { channel, sent } = fakeChannel();
    expect(
      await writing({ channel }).handlers["message.send"](
        send({ attachmentIds: [crypto.randomUUID()] }),
        deadline,
      ),
    ).toEqual({ status: "rejected", reason: "upload_missing" });
    expect(sent).toEqual([]);
  });

  test.each([
    [RESTJSONErrorCodes.MissingPermissions, "forbidden"],
    [RESTJSONErrorCodes.ThreadLocked, "forbidden"],
    [RESTJSONErrorCodes.CannotSendMessagesToThisUser, "dm_closed"],
    [RESTJSONErrorCodes.RequestEntityTooLarge, "file_too_large"],
  ] satisfies [number, WriteRejection][])(
    "Discord's refusal %d becomes %s",
    async (code, reason) => {
      const { channel } = fakeChannel({
        send: async () => {
          throw discordError(code);
        },
      });
      expect(await writing({ channel }).handlers["message.send"](send(), deadline)).toEqual({
        status: "rejected",
        reason,
      });
    },
  );

  test("any other failure is thrown, so the panel sees the command fail", async () => {
    const { channel } = fakeChannel({
      send: async () => {
        throw new Error("network");
      },
    });
    await expect(writing({ channel }).handlers["message.send"](send(), deadline)).rejects.toThrow(
      "network",
    );
  });
});

describe("message.edit", () => {
  const edit = { channelId: CHANNEL, messageId: MESSAGE, content: "nowe", allowMentions: true };

  test("edits the bot's own message with the mention policy", async () => {
    const own = fakeMessage();
    const { channel } = fakeChannel({ fetchMessage: async () => own.message });
    expect(await writing({ channel }).handlers["message.edit"](edit, deadline)).toEqual({
      status: "ok",
    });
    expect(own.seen.edit).toEqual([
      { content: "nowe", allowedMentions: { parse: ["users", "roles"], repliedUser: false } },
    ]);
  });

  test("someone else's message cannot be edited, even with Manage Messages", async () => {
    const theirs = fakeMessage({ author: OLA });
    const { channel } = fakeChannel({ fetchMessage: async () => theirs.message });
    expect(await writing({ channel }).handlers["message.edit"](edit, deadline)).toEqual({
      status: "rejected",
      reason: "not_own",
    });
    expect(theirs.seen.edit).toEqual([]);
  });

  test("an unknown message is rejected", async () => {
    const { channel } = fakeChannel({
      fetchMessage: async () => {
        throw discordError(RESTJSONErrorCodes.UnknownMessage);
      },
    });
    expect(await writing({ channel }).handlers["message.edit"](edit, deadline)).toEqual({
      status: "rejected",
      reason: "unknown_message",
    });
  });
});

describe("message.delete", () => {
  const target = { channelId: CHANNEL, messageId: MESSAGE };

  test("deletes the bot's own message without Manage Messages", async () => {
    const own = fakeMessage();
    const { channel } = fakeChannel({
      permissions: [PermissionFlagsBits.ViewChannel],
      fetchMessage: async () => own.message,
    });
    expect(await writing({ channel }).handlers["message.delete"](target, deadline)).toEqual({
      status: "ok",
    });
    expect(own.seen.deleted).toBe(1);
  });

  test("deletes someone else's message with Manage Messages", async () => {
    const theirs = fakeMessage({ author: OLA });
    const { channel } = fakeChannel({ fetchMessage: async () => theirs.message });
    expect(await writing({ channel }).handlers["message.delete"](target, deadline)).toEqual({
      status: "ok",
    });
    expect(theirs.seen.deleted).toBe(1);
  });

  test("without Manage Messages someone else's message stays, and the panel learns why", async () => {
    const theirs = fakeMessage({ author: OLA });
    const { channel } = fakeChannel({
      permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      fetchMessage: async () => theirs.message,
    });
    expect(await writing({ channel }).handlers["message.delete"](target, deadline)).toEqual({
      status: "rejected",
      reason: "no_manage",
    });
    expect(theirs.seen.deleted).toBe(0);
  });

  test("in a DM the other side's message stays, with a reason of its own", async () => {
    const theirs = fakeMessage({ author: OLA });
    const { channel } = fakeChannel({ dm: true, fetchMessage: async () => theirs.message });
    expect(await writing({ channel }).handlers["message.delete"](target, deadline)).toEqual({
      status: "rejected",
      reason: "dm_not_own",
    });
  });
});

describe("reactions", () => {
  const target = { channelId: CHANNEL, messageId: MESSAGE };

  test("add and remove the bot's own reaction through the own-reaction route", async () => {
    const { channel } = fakeChannel();
    const { handlers, calls } = writing({ channel });
    expect(await handlers["reaction.add"]({ ...target, emoji: "👍" }, deadline)).toEqual({
      status: "ok",
    });
    expect(
      await handlers["reaction.remove"](
        { ...target, emoji: "dzajco:123456789012345678" },
        deadline,
      ),
    ).toEqual({ status: "ok" });
    expect(calls).toEqual([
      ["put", Routes.channelMessageOwnReaction(CHANNEL, MESSAGE, "%F0%9F%91%8D")],
      ["delete", Routes.channelMessageOwnReaction(CHANNEL, MESSAGE, "dzajco:123456789012345678")],
    ]);
  });

  test("reacting needs Read Message History", async () => {
    const { channel } = fakeChannel({ permissions: [PermissionFlagsBits.ViewChannel] });
    const { handlers, calls } = writing({ channel });
    expect(await handlers["reaction.add"]({ ...target, emoji: "👍" }, deadline)).toEqual({
      status: "rejected",
      reason: "no_history",
    });
    expect(calls).toEqual([]);
  });

  test("a new reaction needs Add Reactions; removing the bot's own does not", async () => {
    const { channel } = fakeChannel({
      permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    });
    const { handlers, calls } = writing({ channel });
    expect(await handlers["reaction.add"]({ ...target, emoji: "👍" }, deadline)).toEqual({
      status: "rejected",
      reason: "no_react",
    });
    expect(await handlers["reaction.remove"]({ ...target, emoji: "👍" }, deadline)).toEqual({
      status: "ok",
    });
    expect(calls.map(([method]) => method)).toEqual(["delete"]);
  });

  test("an emoji the bot cannot use is rejected", async () => {
    const { channel } = fakeChannel();
    const { handlers } = writing({
      channel,
      rest: {
        put: async () => {
          throw discordError(RESTJSONErrorCodes.UnknownEmoji);
        },
      },
    });
    expect(
      await handlers["reaction.add"]({ ...target, emoji: "obce:123456789012345678" }, deadline),
    ).toEqual({ status: "rejected", reason: "unknown_emoji" });
  });
});

describe("members.search and dm.open", () => {
  const user = (id: string, username: string, bot = false) => ({
    id,
    username,
    globalName: null,
    bot,
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
    createDM: async () => ({ id: "200000000000000077" }),
  });
  const member = (u: ReturnType<typeof user>) => ({ id: u.id, user: u });

  test("searches every shared server, once per person, without bots", async () => {
    const ola = user(OLA, "ola");
    const asked: unknown[] = [];
    const guild = (id: string, found: ReturnType<typeof user>[]) => ({
      id,
      members: {
        search: async (options: unknown) => {
          asked.push(options);
          return new Map(found.map((u) => [u.id, member(u)]));
        },
      },
    });
    const guilds = new Map([
      [GUILD, guild(GUILD, [ola, user(BOT, "dzajcarz", true)])],
      ["100000000000000002", guild("100000000000000002", [ola])],
    ]);
    const result = await writing({ guilds }).handlers["members.search"](
      { guildId: null, query: "ol" },
      deadline,
    );
    expect(result.members).toEqual([
      {
        id: OLA,
        username: "ola",
        displayName: null,
        avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
      },
    ]);
    expect(asked).toEqual([
      { query: "ol", limit: 25, cache: false },
      { query: "ol", limit: 25, cache: false },
    ]);
  });

  test("searches a few servers at a time and stops once the list is full", async () => {
    let running = 0;
    let most = 0;
    const searched: string[] = [];
    const guild = (n: number) => {
      const id = String(100000000000000000n + BigInt(n));
      return [
        id,
        {
          id,
          members: {
            search: async () => {
              searched.push(id);
              running++;
              most = Math.max(most, running);
              await Bun.sleep(1);
              running--;
              return new Map(
                Array.from({ length: 10 }, (_, i) => {
                  const u = user(String(300000000000000000n + BigInt(n * 100 + i)), `u${n}-${i}`);
                  return [u.id, member(u)];
                }),
              );
            },
          },
        },
      ] as const;
    };
    const guilds = new Map(Array.from({ length: 10 }, (_, n) => guild(n)));
    const result = await writing({ guilds }).handlers["members.search"](
      { guildId: null, query: "ux" },
      deadline,
    );
    expect(most).toBeLessThanOrEqual(SEARCH_CONCURRENCY);
    expect(result.members).toHaveLength(25);
    // 3 servers give 30 members: the fourth batch is never asked.
    expect(searched).toHaveLength(SEARCH_CONCURRENCY);
  });

  test("one server only, and a server that fails is skipped", async () => {
    const failing = {
      id: GUILD,
      members: {
        search: async () => {
          throw new Error("rate limited");
        },
      },
    };
    const result = await writing({ guilds: new Map([[GUILD, failing]]) }).handlers[
      "members.search"
    ]({ guildId: GUILD, query: "ol" }, deadline);
    expect(result).toEqual({ members: [] });
  });

  test("opens the DM channel with a user", async () => {
    const { handlers } = writing({ users: { fetch: async () => user(OLA, "ola") } });
    expect(await handlers["dm.open"]({ userId: OLA }, deadline)).toMatchObject({
      status: "ok",
      channelId: "200000000000000077",
      recipient: { id: OLA, username: "ola" },
    });
  });

  test("an unknown user, or a bot, gets no DM", async () => {
    const unknown = writing({
      users: {
        fetch: async () => {
          throw discordError(RESTJSONErrorCodes.UnknownUser);
        },
      },
    });
    expect(await unknown.handlers["dm.open"]({ userId: OLA }, deadline)).toEqual({
      status: "rejected",
      reason: "unknown_user",
    });
    const bot = writing({ users: { fetch: async () => user(OLA, "inny-bot", true) } });
    expect(await bot.handlers["dm.open"]({ userId: OLA }, deadline)).toEqual({
      status: "rejected",
      reason: "dm_closed",
    });
  });
});
