import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import { createMemoryStore } from "@dzajcarz/kv";
import type { Channel, VoiceState } from "discord.js";
import {
  createPartyModule,
  type PartyArea,
  type PartyChannel,
  type PartyChannels,
  type PartyRepository,
} from "./index.ts";

const MANAGE_CHANNELS = 1n << 4n;
const guildId = "100000000000000001";
const area: PartyArea = { guildId, categoryId: "300", joinChannelId: "400" };

function setup({ moveFails = false, memberGone = false } = {}) {
  const areas = new Map<string, PartyArea>();
  const owned = new Map<string, PartyChannel>();
  const repository: PartyRepository = {
    addArea: async (a) => void areas.set(a.joinChannelId, a),
    listAreas: async (g) => [...areas.values()].filter((a) => a.guildId === g),
    findAreaByJoinChannel: async (id) => areas.get(id) ?? null,
    findAreaByCategory: async (id) => [...areas.values()].find((a) => a.categoryId === id) ?? null,
    deleteArea: async (id) => {
      for (const [channelId, c] of owned) if (c.joinChannelId === id) owned.delete(channelId);
      return areas.delete(id);
    },
    addChannel: async (c) => {
      if ([...owned.values()].some((o) => o.guildId === c.guildId && o.ownerId === c.ownerId)) {
        throw new Error("duplicate owner");
      }
      owned.set(c.channelId, c);
    },
    findChannel: async (id) => owned.get(id) ?? null,
    findChannelByOwner: async (g, u) =>
      [...owned.values()].find((c) => c.guildId === g && c.ownerId === u) ?? null,
    listChannelsOfArea: async (id) => [...owned.values()].filter((c) => c.joinChannelId === id),
    listChannels: async () => [...owned.values()],
    deleteChannel: async (id) => owned.delete(id),
  };

  /** channel id -> member ids; absent = deleted on Discord. */
  const discord = new Map<string, Set<string>>();
  const moves: { userId: string; channelId: string }[] = [];
  const created: { name: string; categoryId: string; ownerId: string }[] = [];
  let nextId = 1000;
  const channels: PartyChannels = {
    async createVoiceChannel(_guild, categoryId, name, ownerId) {
      const id = String(nextId++);
      discord.set(id, new Set());
      created.push({ name, categoryId, ownerId });
      return id;
    },
    async moveMember(_guild, userId, channelId) {
      if (moveFails) throw new Error("Target user is not connected to voice");
      moves.push({ userId, channelId });
      discord.get(channelId)?.add(userId);
    },
    async deleteChannel(channelId) {
      discord.delete(channelId);
    },
    async memberCount(channelId) {
      if (memberGone) return null;
      return discord.get(channelId)?.size ?? null;
    },
    async createCategoryWithJoinChannel() {
      const categoryId = String(nextId++);
      const joinChannelId = String(nextId++);
      discord.set(categoryId, new Set());
      discord.set(joinChannelId, new Set());
      return { categoryId, joinChannelId };
    },
  };

  const warnings: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (message, fields) => void warnings.push({ message, fields }),
    child: () => logger,
  };
  const lock = createMemoryStore();
  const module = createPartyModule({ repository, channels, lock, logger });
  const registry = createRegistry([module]);
  const command = registry.find("party");
  if (!command) throw new Error("party command missing");
  const eventFor = (name: string) => {
    const handler = module.events?.find((e) => e.event === name);
    if (!handler) throw new Error(`${name} handler missing`);
    return handler;
  };

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    memberPermissions: bigint = MANAGE_CHANNELS,
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies.map((r) => replyText(r));
  };
  const voice = (oldChannel: string | null, newChannel: string | null, userId = "u1") =>
    eventFor("voiceStateUpdate").run(
      voiceState(oldChannel, userId),
      voiceState(newChannel, userId),
    );
  return {
    run,
    voice,
    eventFor,
    areas,
    owned,
    discord,
    moves,
    created,
    warnings,
    lock,
    module,
    leave: (channelId: string, userId = "u1") => discord.get(channelId)?.delete(userId),
  };
}

function voiceState(channelId: string | null, userId: string, bot = false): VoiceState {
  return {
    channelId,
    guild: { id: guildId },
    member: { id: userId, displayName: `Ola-${userId}`, user: { bot } },
  } as unknown as VoiceState;
}

describe("/party create", () => {
  test("creates the channels and stores the area", async () => {
    const { run, areas } = setup();
    const [reply] = await run("create", { name: "  Impreza  " });
    const [stored] = [...areas.values()];
    expect(stored?.guildId).toBe(guildId);
    expect(reply).toContain(`<#${stored?.joinChannelId}>`);
  });

  test("needs Manage Channels", async () => {
    const { run, areas } = setup();
    const [reply] = await run("create", { name: "x" }, 0n);
    expect(areas.size).toBe(0);
    expect(reply).toBeDefined();
  });

  test("rejects an empty or too long name", async () => {
    const { run, areas } = setup();
    expect((await run("create", { name: "   " }))[0]).toContain("nazw");
    expect((await run("create", { name: "a".repeat(101) }))[0]).toContain("100");
    expect(areas.size).toBe(0);
  });

  test("removes the new Discord channels when storing the area fails", async () => {
    const deleted: string[] = [];
    const failing = createPartyModule({
      repository: await failingRepo(),
      channels: {
        createVoiceChannel: async () => "1",
        moveMember: async () => {},
        memberCount: async () => 0,
        deleteChannel: async (id) => void deleted.push(id),
        createCategoryWithJoinChannel: async () => ({ categoryId: "c", joinChannelId: "j" }),
      },
      lock: createMemoryStore(),
      logger: silentLogger,
    });
    const ctx = createFakeContext({
      args: { name: "x" },
      subcommand: "create",
      memberPermissions: MANAGE_CHANNELS,
    });
    const command = failing.commands?.[0];
    if (!command) throw new Error("missing");
    await executeCommand(command, ctx, silentLogger);
    expect(deleted.sort()).toEqual(["c", "j"]);
  });
});

async function failingRepo(): Promise<PartyRepository> {
  const nope = async (): Promise<never> => {
    throw new Error("db down");
  };
  return {
    addArea: nope,
    listAreas: async () => [],
    findAreaByJoinChannel: async () => null,
    findAreaByCategory: async () => null,
    deleteArea: async () => false,
    addChannel: nope,
    findChannel: async () => null,
    findChannelByOwner: async () => null,
    listChannelsOfArea: async () => [],
    listChannels: async () => [],
    deleteChannel: async () => false,
  };
}

describe("/party delete", () => {
  test("removes the only area, its channels and the rows", async () => {
    const t = setup();
    t.areas.set(area.joinChannelId, area);
    t.discord.set("400", new Set());
    t.discord.set("300", new Set());
    await t.voice(null, "400");
    expect(t.owned.size).toBe(1);
    const [reply] = await t.run("delete");
    expect(reply).toContain("usunięta");
    expect(t.areas.size).toBe(0);
    expect(t.owned.size).toBe(0);
    expect([...t.discord.keys()]).toEqual([]);
  });

  test("with several areas it asks which one", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.areas.set("401", { guildId, categoryId: "301", joinChannelId: "401" });
    const [reply] = await t.run("delete");
    expect(reply).toContain("<#400>");
    expect(t.areas.size).toBe(2);
    await t.run("delete", { channel: "401" });
    expect([...t.areas.keys()]).toEqual(["400"]);
  });

  test("refuses a channel that is not a join channel and a guild without areas", async () => {
    const t = setup();
    expect((await t.run("delete"))[0]).toContain("nie ma");
    expect((await t.run("delete", { channel: "999" }))[0]).toContain("nie jest");
  });

  test("an area of another guild cannot be deleted", async () => {
    const t = setup();
    t.areas.set("400", { ...area, guildId: "other" });
    await t.run("delete", { channel: "400" });
    expect(t.areas.size).toBe(1);
  });

  test("needs Manage Channels", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.run("delete", {}, 0n);
    expect(t.areas.size).toBe(1);
  });
});

describe("joining the party area", () => {
  test("creates a channel named after the member, stores it and moves them", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    expect(t.created).toEqual([{ name: "Kanał Ola-u1", categoryId: "300", ownerId: "u1" }]);
    expect(t.owned.get("1000")).toEqual({
      channelId: "1000",
      guildId,
      ownerId: "u1",
      joinChannelId: "400",
    });
    expect(t.moves).toEqual([{ userId: "u1", channelId: "1000" }]);
  });

  test("joining any other channel does nothing", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "555");
    expect(t.created).toEqual([]);
  });

  test("a member who owns a channel is moved back to it", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.leave("1000");
    t.discord.get("1000")?.add("friend");
    await t.voice("1000", "400");
    expect(t.created).toHaveLength(1);
    expect(t.moves.at(-1)).toEqual({ userId: "u1", channelId: "1000" });
  });

  test("a stale row whose channel vanished is replaced", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.owned.set("777", { channelId: "777", guildId, ownerId: "u1", joinChannelId: "400" });
    await t.voice(null, "400");
    expect(t.owned.has("777")).toBe(false);
    expect(t.created).toHaveLength(1);
    expect(t.owned.size).toBe(1);
  });

  test("two simultaneous joins by one member create one channel", async () => {
    const t = setup();
    t.areas.set("400", area);
    await Promise.all([t.voice(null, "400"), t.voice(null, "400")]);
    expect(t.created).toHaveLength(1);
    expect(t.owned.size).toBe(1);
  });

  test("the lock is released afterwards", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    expect(await t.lock.get(`party:${guildId}:u1`)).toBeNull();
  });

  test("a failed move deletes the new channel and its row", async () => {
    const t = setup({ moveFails: true });
    t.areas.set("400", area);
    await t.voice(null, "400");
    expect(t.owned.size).toBe(0);
    expect(t.discord.has("1000")).toBe(false);
    expect(t.warnings.map((w) => w.message)).toContain("Party channel not created");
  });

  test("bots do not get channels", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t
      .eventFor("voiceStateUpdate")
      .run(voiceState(null, "b1", true), voiceState("400", "b1", true));
    expect(t.created).toEqual([]);
  });

  test("a mute or deafen change in the join channel is not a join", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice("400", "400");
    expect(t.created).toEqual([]);
  });

  test("a database failure is logged, not thrown", async () => {
    const t = setup();
    t.areas.set("400", area);
    const original = t.owned.set.bind(t.owned);
    t.owned.set = () => {
      throw new Error("db down");
    };
    await t.voice(null, "400");
    t.owned.set = original;
    expect(t.warnings).toHaveLength(1);
    expect(t.discord.has("1000")).toBe(false);
  });
});

describe("leaving a party channel", () => {
  test("the last member leaving deletes the channel and the row", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.leave("1000");
    await t.voice("1000", null);
    expect(t.owned.size).toBe(0);
    expect(t.discord.has("1000")).toBe(false);
  });

  test("a channel with someone left in it stays", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.discord.get("1000")?.add("friend");
    t.leave("1000");
    await t.voice("1000", null);
    expect(t.owned.size).toBe(1);
    expect(t.discord.has("1000")).toBe(true);
  });

  test("leaving an ordinary channel does nothing", async () => {
    const t = setup();
    t.discord.set("555", new Set());
    await t.voice("555", null);
    expect(t.discord.has("555")).toBe(true);
  });

  test("moving from your channel into the join channel gives a fresh one", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.leave("1000");
    await t.voice("1000", "400");
    expect(t.created).toHaveLength(2);
    expect(t.owned.has("1000")).toBe(false);
    expect(t.owned.has("1001")).toBe(true);
  });
});

describe("channelDelete", () => {
  const deleted = (id: string) => ({ id }) as unknown as Channel;

  test("deleting the join channel removes the area and its party channels", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    await t.eventFor("channelDelete").run(deleted("400"));
    expect(t.areas.size).toBe(0);
    expect(t.owned.size).toBe(0);
    expect(t.discord.has("1000")).toBe(false);
  });

  test("deleting the category removes the area", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.eventFor("channelDelete").run(deleted("300"));
    expect(t.areas.size).toBe(0);
  });

  test("deleting a party channel removes only its row", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    await t.eventFor("channelDelete").run(deleted("1000"));
    expect(t.owned.size).toBe(0);
    expect(t.areas.size).toBe(1);
  });

  test("an unrelated channel is ignored", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.eventFor("channelDelete").run(deleted("999"));
    expect(t.areas.size).toBe(1);
  });
});

describe("startup reconciliation", () => {
  const ready = {} as never;

  test("removes empty and vanished channels, keeps occupied ones", async () => {
    const t = setup();
    t.areas.set("400", area);
    const row = (id: string, owner: string) =>
      t.owned.set(id, { channelId: id, guildId, ownerId: owner, joinChannelId: "400" });
    row("1", "a");
    row("2", "b");
    row("3", "c");
    t.discord.set("1", new Set()); // empty
    t.discord.set("2", new Set(["b"])); // occupied
    // "3" no longer exists on Discord
    await t.eventFor("clientReady").run(ready);
    expect([...t.owned.keys()]).toEqual(["2"]);
    expect(t.discord.has("1")).toBe(false);
    expect(t.discord.has("2")).toBe(true);
  });

  test("is a once-handler and tolerates a failing channel check", async () => {
    const t = setup({ memberGone: true });
    t.areas.set("400", area);
    t.owned.set("1", { channelId: "1", guildId, ownerId: "a", joinChannelId: "400" });
    expect(t.eventFor("clientReady").once).toBe(true);
    await t.eventFor("clientReady").run(ready);
    expect(t.owned.size).toBe(0);
  });
});
