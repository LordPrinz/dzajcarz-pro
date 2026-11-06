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

interface SetupOptions {
  moveFails?: boolean;
  memberGone?: boolean;
  deleteFails?: boolean;
  lock?: ReturnType<typeof createMemoryStore>;
}

const longAgo = new Date(Date.now() - 3_600_000);

function row(channelId: string, ownerId: string, joinChannelId = "400"): PartyChannel {
  return { channelId, guildId, ownerId, joinChannelId, createdAt: longAgo };
}

function setup({
  moveFails = false,
  memberGone = false,
  deleteFails = false,
  lock,
}: SetupOptions = {}) {
  const areas = new Map<string, PartyArea>();
  const owned = new Map<string, PartyChannel>();
  const repository: PartyRepository = {
    addArea: async (a) => void areas.set(a.joinChannelId, a),
    listAreas: async (g) => [...areas.values()].filter((a) => a.guildId === g),
    findAreaByJoinChannel: async (id) => areas.get(id) ?? null,
    findAreaByCategory: async (id) => [...areas.values()].find((a) => a.categoryId === id) ?? null,
    listAllAreas: async () => [...areas.values()],
    deleteArea: async (id) => {
      const removed = [...owned.values()].filter((c) => c.joinChannelId === id);
      for (const c of removed) owned.delete(c.channelId);
      return areas.delete(id) ? removed : null;
    },
    addChannel: async (c) => {
      if ([...owned.values()].some((o) => o.guildId === c.guildId && o.ownerId === c.ownerId)) {
        throw new Error("duplicate owner");
      }
      owned.set(c.channelId, { ...c, createdAt: longAgo });
    },
    findChannel: async (id) => owned.get(id) ?? null,
    findChannelByOwner: async (g, u) =>
      [...owned.values()].find((c) => c.guildId === g && c.ownerId === u) ?? null,
    listChannelsOfArea: async (id) => [...owned.values()].filter((c) => c.joinChannelId === id),
    listChannels: async () => [...owned.values()],
    deleteChannel: async (id) => owned.delete(id),
    transferOwner: async (channelId, newOwnerId) => {
      const channel = owned.get(channelId);
      if (!channel) return false;
      const taken = [...owned.values()].some(
        (c) => c.guildId === channel.guildId && c.ownerId === newOwnerId,
      );
      if (taken) return false;
      owned.set(channelId, { ...channel, ownerId: newOwnerId });
      return true;
    },
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
      for (const members of discord.values()) members.delete(userId);
      discord.get(channelId)?.add(userId);
    },
    async deleteChannel(channelId) {
      if (deleteFails) throw new Error("Missing Permissions");
      discord.delete(channelId);
    },
    async members(channelId) {
      if (memberGone) return null;
      const members = discord.get(channelId);
      return members ? [...members] : null;
    },
    async exists(channelId) {
      return discord.has(channelId);
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
  const store = lock ?? createMemoryStore();
  const module = createPartyModule({ repository, channels, lock: store, logger });
  const registry = createRegistry([module]);
  const command = registry.find("party");
  if (!command) throw new Error("party command missing");
  const eventFor = (name: string) => {
    const handler = module.events?.find((e) => e.name === name || e.event === name);
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
  /** Discord changes its state first, then calls every listener in registration order without waiting. */
  const voice = async (oldChannel: string | null, newChannel: string | null, userId = "u1") => {
    if (oldChannel) discord.get(oldChannel)?.delete(userId);
    if (newChannel) {
      if (!discord.has(newChannel)) discord.set(newChannel, new Set());
      discord.get(newChannel)?.add(userId);
    }
    const before = voiceState(oldChannel, userId);
    const after = voiceState(newChannel, userId);
    await Promise.all([
      eventFor("party-leave").run(before, after),
      eventFor("party-join").run(before, after),
    ]);
  };
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
    lock: store,
    module,
    leave: (channelId: string, userId = "u1") => discord.get(channelId)?.delete(userId),
    addMember: (channelId: string, userId: string) => discord.get(channelId)?.add(userId),
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
        members: async () => [],
        exists: async () => true,
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
    listAllAreas: async () => [],
    findAreaByJoinChannel: async () => null,
    findAreaByCategory: async () => null,
    deleteArea: async () => null,
    addChannel: nope,
    findChannel: async () => null,
    findChannelByOwner: async () => null,
    listChannelsOfArea: async () => [],
    listChannels: async () => [],
    deleteChannel: async () => false,
    transferOwner: async () => false,
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
    expect(t.owned.get("1000")).toMatchObject({
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

  test("a member who still owns an occupied channel is moved back to it", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    // The friend owns a channel of their own, so ownership cannot pass to them when u1 leaves.
    t.owned.set("2000", row("2000", "friend"));
    t.discord.set("2000", new Set());
    t.addMember("1000", "friend");
    await t.voice("1000", "400");
    expect(t.created).toHaveLength(1);
    expect(t.moves.at(-1)).toEqual({ userId: "u1", channelId: "1000" });
  });

  test("a move failure keeps an existing occupied channel", async () => {
    const failing = setup({ moveFails: true });
    failing.areas.set("400", area);
    failing.owned.set("1000", row("1000", "u1"));
    failing.discord.set("1000", new Set(["friend"]));
    await failing.voice(null, "400");
    expect(failing.owned.has("1000")).toBe(true);
    expect(failing.discord.has("1000")).toBe(true);
    expect(failing.created).toEqual([]);
    expect(failing.warnings.map((w) => w.message)).toContain("Party channel not created");
  });

  test("a member who left the join channel meanwhile gets no channel", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.eventFor("party-join").run(voiceState(null, "u1"), voiceState("400", "u1"));
    // u1 never shows up in the join channel (Discord already moved them on).
    expect(t.created).toHaveLength(1);
    expect(t.owned.size).toBe(0);
    expect(t.discord.has("1000")).toBe(false);
    expect(t.moves).toEqual([]);
  });

  test("an existing channel is left alone when the member left the join channel", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.owned.set("1000", row("1000", "u1"));
    t.discord.set("1000", new Set(["friend"]));
    await t.eventFor("party-join").run(voiceState(null, "u1"), voiceState("400", "u1"));
    expect(t.owned.has("1000")).toBe(true);
    expect(t.discord.has("1000")).toBe(true);
  });

  test("with Redis down the join goes ahead", async () => {
    const down = createMemoryStore();
    down.setIfAbsent = async () => {
      throw new Error("redis down");
    };
    const t = setup({ lock: down });
    t.areas.set("400", area);
    await t.voice(null, "400");
    expect(t.created).toHaveLength(1);
    expect(t.moves).toEqual([{ userId: "u1", channelId: "1000" }]);
  });

  test("an expired lock is not released over its new holder", async () => {
    const t = setup();
    t.areas.set("400", area);
    const key = `party:${guildId}:u1`;
    const original = t.lock.setIfAbsent.bind(t.lock);
    t.lock.setIfAbsent = async (k, v, ttl) => {
      const got = await original(k, v, ttl);
      // Simulates the TTL ending and another process taking the lock mid-join.
      await t.lock.del(k);
      await original(k, "other-holder", ttl);
      return got;
    };
    await t.voice(null, "400");
    expect(await t.lock.get(key)).toBe("other-holder");
  });

  test("at most three channels per minute are created for one member", async () => {
    const t = setup();
    t.areas.set("400", area);
    for (let i = 0; i < 5; i++) {
      await t.voice(null, "400");
      await t.voice(t.moves.at(-1)?.channelId ?? null, null);
    }
    expect(t.created).toHaveLength(3);
  });

  test("a stale row whose channel vanished is replaced", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.owned.set("777", row("777", "u1"));
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
    await t.eventFor("party-join").run(voiceState(null, "b1", true), voiceState("400", "b1", true));
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

  test("when the owner leaves and others stay, ownership passes to one of them", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.discord.get("1000")?.add("friend");
    await t.voice("1000", null);
    expect(t.owned.get("1000")?.ownerId).toBe("friend");
    expect(t.discord.has("1000")).toBe(true);
  });

  test("ownership skips a member who owns another channel and stays if nobody can take it", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.owned.set("2000", row("2000", "busy"));
    t.discord.get("1000")?.add("busy");
    t.discord.get("1000")?.add("free");
    await t.voice("1000", null);
    expect(t.owned.get("1000")?.ownerId).toBe("free");

    const stuck = setup();
    stuck.areas.set("400", area);
    await stuck.voice(null, "400");
    stuck.owned.set("2000", row("2000", "busy"));
    stuck.discord.get("1000")?.add("busy");
    await stuck.voice("1000", null);
    expect(stuck.owned.get("1000")?.ownerId).toBe("u1");
  });

  test("a non-owner leaving keeps the owner", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    await t.voice(null, "1000", "friend");
    await t.voice("1000", null, "friend");
    expect(t.owned.get("1000")?.ownerId).toBe("u1");
  });

  test("a failed Discord delete keeps the row so a later leave retries", async () => {
    const t = setup({ deleteFails: true });
    t.areas.set("400", area);
    await t.voice(null, "400");
    await t.voice("1000", null);
    expect(t.owned.has("1000")).toBe(true);
    expect(t.warnings.map((w) => w.message)).toContain(
      "Could not delete channel, keeping its row to retry later",
    );
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

  test("cleanup handlers run even when the module is switched off", () => {
    const { module } = setup();
    const always = module.events?.filter((e) => e.alwaysRun).map((e) => e.name);
    expect(always?.sort()).toEqual(["party-channel-delete", "party-leave", "party-reconcile"]);
    expect(module.events?.find((e) => e.name === "party-join")?.alwaysRun).toBeUndefined();
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

  test("deleting the category removes the area and the join channel", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.discord.set("400", new Set());
    await t.eventFor("channelDelete").run(deleted("300"));
    expect(t.areas.size).toBe(0);
    expect(t.discord.has("400")).toBe(false);
  });

  test("deleting the join channel removes the category too", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.discord.set("300", new Set());
    await t.eventFor("channelDelete").run(deleted("400"));
    expect(t.discord.has("300")).toBe(false);
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
    t.discord.set("400", new Set());
    t.discord.set("300", new Set());
    for (const [id, owner] of [
      ["1", "a"],
      ["2", "b"],
      ["3", "c"],
    ] as const) {
      t.owned.set(id, row(id, owner));
    }
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
    t.discord.set("400", new Set());
    t.discord.set("300", new Set());
    t.owned.set("1", row("1", "a"));
    expect(t.eventFor("clientReady").once).toBe(true);
    await t.eventFor("clientReady").run(ready);
    expect(t.owned.size).toBe(0);
  });

  test("skips channels younger than 15 seconds", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.discord.set("400", new Set());
    t.discord.set("300", new Set());
    t.owned.set("1", { ...row("1", "a"), createdAt: new Date() });
    t.discord.set("1", new Set());
    await t.eventFor("clientReady").run(ready);
    expect(t.owned.has("1")).toBe(true);
  });

  test("drops an area whose join channel or category is gone", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.discord.set("300", new Set()); // the join channel 400 was deleted while offline
    t.areas.set("401", { guildId, categoryId: "301", joinChannelId: "401" });
    t.discord.set("401", new Set());
    t.discord.set("301", new Set()); // this one is intact
    t.owned.set("1", row("1", "a"));
    t.discord.set("1", new Set(["a"]));
    await t.eventFor("clientReady").run(ready);
    expect([...t.areas.keys()]).toEqual(["401"]);
    expect(t.owned.size).toBe(0);
    expect(t.discord.has("300")).toBe(false);
    expect(t.discord.has("1")).toBe(false);
  });
});
