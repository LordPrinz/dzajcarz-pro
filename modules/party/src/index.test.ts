import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText, submitModal } from "@dzajcarz/core/testing";
import { createMemoryStore } from "@dzajcarz/kv";
import type { Channel, VoiceState } from "discord.js";
import {
  createPartyModule,
  type PartyArea,
  type PartyChannel,
  type PartyChannels,
  type PartyPermissions,
  type PartyRepository,
  renderChannelName,
  validateTemplate,
} from "./index.ts";

const MANAGE_CHANNELS = 1n << 4n;
const guildId = "100000000000000001";
const area: PartyArea = {
  guildId,
  categoryId: "300",
  joinChannelId: "400",
  nameTemplate: "Kanał {user}",
  commandChannel: false,
};

interface SetupOptions {
  moveFails?: boolean;
  memberGone?: boolean;
  deleteFails?: boolean;
  lock?: ReturnType<typeof createMemoryStore>;
  allowFails?: boolean;
  allowSelfFails?: boolean;
  renameFails?: boolean;
  /** What the channel's category says about @everyone. */
  inherited?: { connect: boolean | null; view: boolean | null };
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
  allowFails = false,
  allowSelfFails = false,
  renameFails = false,
  inherited = { connect: null, view: null },
}: SetupOptions = {}) {
  const areas = new Map<string, PartyArea>();
  const owned = new Map<string, PartyChannel>();
  const repository: PartyRepository = {
    addArea: async (a) => void areas.set(a.joinChannelId, a),
    updateArea: async (id, settings) => {
      const current = areas.get(id);
      if (!current) return false;
      areas.set(id, { ...current, ...settings });
      return true;
    },
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
    transferOwner: async (channelId, expectedOwnerId, newOwnerId) => {
      const channel = owned.get(channelId);
      if (!channel || channel.ownerId !== expectedOwnerId) return false;
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
  const categories: { categoryName: string; joinChannelName: string }[] = [];
  const renamed: { categoryId: string; joinChannelId: string; categoryName: string }[] = [];
  const names = new Map<string, string>();
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
    async createCategoryWithJoinChannel(_guild, categoryName, joinChannelName) {
      categories.push({ categoryName, joinChannelName });
      const categoryId = String(nextId++);
      const joinChannelId = String(nextId++);
      discord.set(categoryId, new Set());
      discord.set(joinChannelId, new Set());
      return { categoryId, joinChannelId };
    },
    async voiceChannelOf(_guild, userId) {
      for (const [id, members] of discord) if (members.has(userId)) return id;
      return null;
    },
    async areaNames(categoryId, joinChannelId) {
      return {
        categoryName: names.get(categoryId) ?? "Impreza",
        joinChannelName: names.get(joinChannelId) ?? "Wejście",
      };
    },
    async renameArea(categoryId, joinChannelId, newNames) {
      if (renameFails) throw new Error("Missing Permissions");
      renamed.push({ categoryId, joinChannelId, categoryName: newNames.categoryName });
      names.set(categoryId, newNames.categoryName);
      names.set(joinChannelId, newNames.joinChannelName);
    },
  };

  /** Everything the fake Discord was asked to change on channels, in order. */
  const calls: string[] = [];
  const guildMembers = new Set(["u1", "u2", "friend", "bot-self", "mod"]);
  /** Members with guild-wide Administrator, Manage Channels or Move Members. */
  const moderators = new Set(["mod"]);
  /** Members with Manage Channels on the party channel itself. */
  const managers = new Set<string>();
  const permissions: PartyPermissions = {
    async setEveryone(channelId, access, reason) {
      calls.push(`everyone ${channelId} ${JSON.stringify(access)} (${reason})`);
    },
    async inheritedEveryone() {
      return inherited;
    },
    async allowSelf(channelId) {
      if (allowSelfFails) throw new Error("Missing Permissions");
      calls.push(`self ${channelId}`);
    },
    async allowMember(channelId, userId) {
      if (allowFails) throw new Error("Missing Permissions");
      calls.push(`allow ${channelId} ${userId}`);
    },
    async denyMember(channelId, userId) {
      calls.push(`deny ${channelId} ${userId}`);
    },
    async clearMember(channelId, userId) {
      calls.push(`clear ${channelId} ${userId}`);
    },
    async setLimit(channelId, limit) {
      calls.push(`limit ${channelId} ${limit}`);
    },
    async rename(channelId, name) {
      calls.push(`rename ${channelId} ${name}`);
    },
    async disconnect(_guild, userId, channelId) {
      calls.push(`disconnect ${userId} ${channelId}`);
      discord.get(channelId)?.delete(userId);
    },
    async lookupMember(_guild, userId) {
      return guildMembers.has(userId)
        ? { self: userId === "bot-self", moderator: moderators.has(userId) }
        : null;
    },
    async canManage(_guild, userId) {
      return managers.has(userId);
    },
  };

  const warnings: { message: string; fields?: LogFields }[] = [];
  const infos: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (message, fields) => void warnings.push({ message, fields }),
    info: (message, fields) => void infos.push({ message, fields }),
    child: () => logger,
  };
  const store = lock ?? createMemoryStore();
  const module = createPartyModule({ repository, channels, permissions, lock: store, logger });
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
    userId?: string,
    invocation: "slash" | "prefix" = "slash",
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions, userId, invocation });
    await executeCommand(command, ctx, silentLogger);
    return Object.assign(
      ctx.replies.map((r) => replyText(r)),
      { deferOptions: ctx.deferOptions, modals: ctx.modals },
    );
  };
  const submit = (
    customId: string,
    values: Record<string, string>,
    memberPermissions: bigint = MANAGE_CHANNELS,
  ) => submitModal({ registry, customId, values, memberPermissions, guildId });
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
    categories,
    renamed,
    names,
    submit,
    calls,
    managers,
    warnings,
    infos,
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
    const [reply] = await run(
      "create",
      { name: "  Impreza  " },
      MANAGE_CHANNELS,
      undefined,
      "prefix",
    );
    const [stored] = [...areas.values()];
    expect(stored?.guildId).toBe(guildId);
    expect(reply).toContain(`<#${stored?.joinChannelId}>`);
  });

  test("needs Manage Channels", async () => {
    const { run, areas } = setup();
    const [reply] = await run("create", { name: "x" }, 0n, undefined, "prefix");
    expect(areas.size).toBe(0);
    expect(reply).toBeDefined();
  });

  test("rejects an empty or too long name", async () => {
    const { run, areas } = setup();
    expect(
      (await run("create", { name: "   " }, MANAGE_CHANNELS, undefined, "prefix"))[0],
    ).toContain("nazw");
    expect(
      (await run("create", { name: "a".repeat(101) }, MANAGE_CHANNELS, undefined, "prefix"))[0],
    ).toContain("100");
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
        voiceChannelOf: async () => null,
        areaNames: async () => null,
        renameArea: async () => {},
      },
      permissions: {} as PartyPermissions,
      lock: createMemoryStore(),
      logger: silentLogger,
    });
    const ctx = createFakeContext({
      args: { name: "x" },
      subcommand: "create",
      invocation: "prefix",
      memberPermissions: MANAGE_CHANNELS,
    });
    const command = failing.commands?.[0];
    if (!command) throw new Error("missing");
    await executeCommand(command, ctx, silentLogger);
    expect(deleted.sort()).toEqual(["c", "j"]);
  });
});

describe("party area form", () => {
  const form = {
    categoryName: "  Impreza ",
    joinChannelName: "Wejście",
    nameTemplate: "🔥 {user}",
    commandChannel: "on",
  };

  test("/party create opens the form with defaults instead of creating", async () => {
    const t = setup();
    const answer = await t.run("create");
    expect(answer.modals).toHaveLength(1);
    const fields = Object.fromEntries(
      answer.modals[0]?.fields.map((f) => [f.customId, f.value]) ?? [],
    );
    expect(fields).toMatchObject({ nameTemplate: "Kanał {user}", commandChannel: "off" });
    expect(t.areas.size).toBe(0);
  });

  test("a name typed with /party create prefills the form", async () => {
    const t = setup();
    const answer = await t.run("create", { name: "Impreza" });
    expect(answer.modals[0]?.fields.find((f) => f.customId === "categoryName")?.value).toBe(
      "Impreza",
    );
  });

  test("submitting the form creates the area with its template and flag", async () => {
    const t = setup();
    const [spec] = (await t.run("create")).modals;
    const ctx = await t.submit(spec?.customId ?? "", form);
    const [stored] = [...t.areas.values()];
    expect(stored).toMatchObject({ guildId, nameTemplate: "🔥 {user}", commandChannel: true });
    expect(t.categories).toEqual([{ categoryName: "Impreza", joinChannelName: "Wejście" }]);
    expect(replyText(ctx.replies[0])).toContain(`<#${stored?.joinChannelId}>`);
  });

  test("the form refuses a bad template or flag with a Polish message and creates nothing", async () => {
    const t = setup();
    const [spec] = (await t.run("create")).modals;
    const id = spec?.customId ?? "";
    const noUser = await t.submit(id, { ...form, nameTemplate: "Impreza" });
    expect(replyText(noUser.replies[0])).toContain("{user}");
    const long = await t.submit(id, { ...form, nameTemplate: `${"a".repeat(86)}{user}` });
    expect(replyText(long.replies[0])).toContain("90");
    const flag = await t.submit(id, { ...form, commandChannel: "może" });
    expect(replyText(flag.replies[0])).toContain("nieprawidłową");
    const blank = await t.submit(id, { ...form, categoryName: "   " });
    expect(blank.replies).toHaveLength(1);
    expect(t.areas.size).toBe(0);
  });

  test("the form needs Manage Channels", async () => {
    const t = setup();
    const [spec] = (await t.run("create")).modals;
    await t.submit(spec?.customId ?? "", form, 0n);
    expect(t.areas.size).toBe(0);
  });

  test("/party create by prefix keeps the arguments and uses the default template", async () => {
    const t = setup();
    await t.run("create", { name: "Impreza" }, MANAGE_CHANNELS, undefined, "prefix");
    const [stored] = [...t.areas.values()];
    expect(stored).toMatchObject({ nameTemplate: "Kanał {user}", commandChannel: false });
    expect(t.categories[0]?.categoryName).toBe("Impreza");
  });

  describe("/party edit", () => {
    test("opens the form filled with the current values", async () => {
      const t = setup();
      t.areas.set("400", { ...area, nameTemplate: "💥 {user}", commandChannel: true });
      const answer = await t.run("edit");
      const fields = Object.fromEntries(
        answer.modals[0]?.fields.map((f) => [f.customId, f.value]) ?? [],
      );
      expect(fields).toEqual({
        categoryName: "Impreza",
        joinChannelName: "Wejście",
        nameTemplate: "💥 {user}",
        commandChannel: "on",
      });
    });

    test("never splits a surrogate pair when cutting the prefill", async () => {
      const t = setup();
      t.areas.set("400", { ...area, nameTemplate: `${"a".repeat(89)}🎉{user}` });
      const answer = await t.run("edit");
      const template = answer.modals[0]?.fields.find((f) => f.customId === "nameTemplate")?.value;
      expect(template).toBe("a".repeat(89));
    });

    test("submit renames the channels and updates the row", async () => {
      const t = setup();
      t.areas.set("400", area);
      const [spec] = (await t.run("edit")).modals;
      const ctx = await t.submit(spec?.customId ?? "", { ...form, categoryName: "Zabawa" });
      expect(t.renamed).toEqual([
        { categoryId: "300", joinChannelId: "400", categoryName: "Zabawa" },
      ]);
      expect(t.areas.get("400")).toMatchObject({ nameTemplate: "🔥 {user}", commandChannel: true });
      expect(replyText(ctx.replies[0])).toContain("zaktualizowana");
    });

    test("renames only the channel whose name changed", async () => {
      const t = setup();
      t.areas.set("400", area);
      const [spec] = (await t.run("edit")).modals;
      const ctx = await t.submit(spec?.customId ?? "", { ...form, categoryName: "Impreza" });
      expect(t.renamed).toEqual([]);
      expect(replyText(ctx.replies[0])).toContain("zaktualizowana");
      const second = await t.submit(spec?.customId ?? "", { ...form, categoryName: "Nowa" });
      expect(t.renamed).toEqual([
        { categoryId: "300", joinChannelId: "400", categoryName: "Nowa" },
      ]);
      expect(t.names.get("400")).toBe("Wejście");
      expect(replyText(second.replies[0])).toContain("zaktualizowana");
    });

    test("saves the settings and says so when Discord refuses the rename", async () => {
      const t = setup({ renameFails: true });
      t.areas.set("400", area);
      const [spec] = (await t.run("edit")).modals;
      const ctx = await t.submit(spec?.customId ?? "", { ...form, categoryName: "Zabawa" });
      expect(replyText(ctx.replies[0])).toContain("Ustawienia zapisane, ale nie udało się");
      expect(t.areas.get("400")).toMatchObject({ nameTemplate: "🔥 {user}", commandChannel: true });
    });

    test("saves the settings and skips a rename over the limit, before touching Discord", async () => {
      const t = setup();
      t.areas.set("400", area);
      const [spec] = (await t.run("edit")).modals;
      const id = spec?.customId ?? "";
      await t.submit(id, { ...form, categoryName: "A" });
      await t.submit(id, { ...form, categoryName: "B" });
      const ctx = await t.submit(id, { ...form, categoryName: "C", nameTemplate: "💥 {user}" });
      expect(replyText(ctx.replies[0])).toBe(
        "Ustawienia zapisane, ale nazwy kategorii nie zmieniono: Discord pozwala zmienić nazwę 2 razy na 10 minut.",
      );
      expect(t.renamed.map((r) => r.categoryName)).toEqual(["A", "B"]);
      expect(t.areas.get("400")?.nameTemplate).toBe("💥 {user}");
    });

    test("says so when the area was removed meanwhile", async () => {
      const t = setup();
      t.areas.set("400", area);
      const [spec] = (await t.run("edit")).modals;
      t.areas.clear();
      const ctx = await t.submit(spec?.customId ?? "", form);
      expect(replyText(ctx.replies[0])).toContain("nie istnieje");
    });

    test("picks the area with the channel option when there are several", async () => {
      const t = setup();
      t.areas.set("400", area);
      t.areas.set("401", { ...area, categoryId: "301", joinChannelId: "401" });
      expect((await t.run("edit"))[0]).toContain("kilka");
      const answer = await t.run("edit", { channel: "401" });
      expect(answer.modals[0]?.customId).toContain(":401");
    });

    test("by prefix it points to the slash command", async () => {
      const t = setup();
      t.areas.set("400", area);
      const answer = await t.run("edit", {}, MANAGE_CHANNELS, undefined, "prefix");
      expect(answer[0]).toContain("/party edit");
    });

    test("needs Manage Channels", async () => {
      const t = setup();
      t.areas.set("400", area);
      const answer = await t.run("edit", {}, 0n);
      expect(answer.modals).toHaveLength(0);
    });
  });
});

describe("channel name template", () => {
  test("replaces {user} and trims to 100 characters", () => {
    expect(renderChannelName("🎉 {user}", "Ola")).toBe("🎉 Ola");
    expect(renderChannelName("{user} & {user}", "Ola")).toBe("Ola & Ola");
    expect([...renderChannelName("🎉 {user}", "x".repeat(200))]).toHaveLength(100);
    expect([...renderChannelName("{user}", "🎉".repeat(150))]).toHaveLength(100);
  });

  test("never produces an empty name and ignores $ patterns in names", () => {
    expect(renderChannelName("{user}", "   ")).toBe("Kanał imprezowy");
    expect(renderChannelName("{user}", "a$&b")).toBe("a$&b");
    expect(renderChannelName("x {user}", "A\nB")).toBe("x A B");
    expect(renderChannelName("{user}", "\u200b\u2060")).toBe("Kanał imprezowy");
    expect(renderChannelName("\u200b{user}", "A\u200bB")).toBe("AB");
  });

  test("validation wants {user} and a sensible length", () => {
    expect(() => validateTemplate("🎉 {user}")).not.toThrow();
    expect(() => validateTemplate("   ")).toThrow("pusty");
    expect(() => validateTemplate("bez")).toThrow("{user}");
    expect(() => validateTemplate(`${"a".repeat(85)}{user}`)).toThrow("90");
  });

  test("a new party channel uses the area template", async () => {
    const t = setup();
    t.areas.set("400", { ...area, nameTemplate: "🎉 {user}" });
    t.discord.set("400", new Set());
    await t.voice(null, "400");
    expect(t.created[0]?.name).toBe("🎉 Ola-u1");
  });
});

async function failingRepo(): Promise<PartyRepository> {
  const nope = async (): Promise<never> => {
    throw new Error("db down");
  };
  return {
    addArea: nope,
    updateArea: async () => false,
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
    const replies = await t.run("delete");
    expect(replies[0]).toContain("usunięta");
    expect(replies.deferOptions).toEqual({ ephemeral: true });
    expect(t.areas.size).toBe(0);
    expect(t.owned.size).toBe(0);
    expect([...t.discord.keys()]).toEqual([]);
  });

  test("with several areas it asks which one", async () => {
    const t = setup();
    t.areas.set("400", area);
    t.areas.set("401", { ...area, categoryId: "301", joinChannelId: "401" });
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
    t.areas.set("401", { ...area, categoryId: "301", joinChannelId: "401" });
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

describe("owner controls", () => {
  /** u1 joins the area and ends up owning channel 1000 with `friend` and u2 around. */
  async function withChannel(options: SetupOptions = {}) {
    const t = setup(options);
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.calls.length = 0;
    return t;
  }
  const none = 0n;

  test("the command itself has no permission gate, only create and delete do", () => {
    const t = setup();
    const command = t.module.commands?.[0];
    expect(command?.permissions).toBeUndefined();
    const subs = (command as { subcommands: Record<string, { permissions?: bigint }> }).subcommands;
    expect(subs.create?.permissions).toBe(MANAGE_CHANNELS);
    expect(subs.delete?.permissions).toBe(MANAGE_CHANNELS);
    expect(subs.lock?.permissions).toBeUndefined();
  });

  test("lock and unlock change only Connect for @everyone", async () => {
    const t = await withChannel();
    expect((await t.run("lock", {}, none, "u1"))[0]).toContain("zamknięty");
    await t.run("unlock", {}, none, "u1");
    expect(t.calls).toEqual([
      'everyone 1000 {"connect":false} (Party: lock by u1)',
      'everyone 1000 {"connect":null} (Party: unlock by u1)',
    ]);
  });

  test("unlock and show restore the category's @everyone value instead of clearing it", async () => {
    const t = setup({ inherited: { connect: false, view: false } });
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.calls.length = 0;
    await t.run("unlock", {}, none, "u1");
    await t.run("show", {}, none, "u1");
    expect(t.calls).toEqual([
      'everyone 1000 {"connect":false} (Party: unlock by u1)',
      'everyone 1000 {"view":false} (Party: show by u1)',
    ]);
  });

  test("hide and show change only ViewChannel", async () => {
    const t = await withChannel();
    await t.run("hide", {}, none, "u1");
    await t.run("show", {}, none, "u1");
    expect(t.calls).toEqual([
      'everyone 1000 {"view":false} (Party: hide by u1)',
      'everyone 1000 {"view":null} (Party: show by u1)',
    ]);
  });

  test("limit sets the number and 0 removes it", async () => {
    const t = await withChannel();
    expect((await t.run("limit", { count: 5 }, none, "u1"))[0]).toContain("5");
    expect((await t.run("limit", { count: 0 }, none, "u1"))[0]).toContain("usunięty");
    expect(t.calls).toEqual(["limit 1000 5", "limit 1000 0"]);
  });

  test("rename trims, counts code points and rejects empty or long names", async () => {
    const t = await withChannel();
    await t.run("rename", { name: "  Sala 🎉  " }, none, "u1");
    expect(t.calls).toEqual(["rename 1000 Sala 🎉"]);
    expect((await t.run("rename", { name: "   " }, none, "u1"))[0]).toContain("nazwę");
    expect((await t.run("rename", { name: "🎉".repeat(101) }, none, "u1"))[0]).toContain("100");
    // 100 emoji are 200 UTF-16 units but still fit.
    await t.run("rename", { name: "🎉".repeat(100) }, none, "u1");
    expect(t.calls).toHaveLength(2);
  });

  test("a channel can be renamed twice per window, then Discord is not called", async () => {
    const t = await withChannel();
    await t.run("rename", { name: "Jeden" }, none, "u1");
    await t.run("rename", { name: "Dwa" }, none, "u1");
    const [reply] = await t.run("rename", { name: "Trzy" }, none, "u1");
    expect(reply).toBe("Discord pozwala zmienić nazwę 2 razy na 10 minut.");
    expect(t.calls).toEqual(["rename 1000 Jeden", "rename 1000 Dwa"]);
  });

  test("with Redis down a rename goes through", async () => {
    const store = createMemoryStore();
    store.increment = async () => {
      throw new Error("redis down");
    };
    const t = setup({ lock: store });
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.calls.length = 0;
    for (const name of ["a", "b", "c"]) await t.run("rename", { name }, none, "u1");
    expect(t.calls).toEqual(["rename 1000 a", "rename 1000 b", "rename 1000 c"]);
  });

  test("an eleventh control command within a minute gets a Polish answer", async () => {
    const t = await withChannel();
    for (let i = 0; i < 10; i++) await t.run("limit", { count: 5 }, none, "u1");
    const [reply] = await t.run("limit", { count: 5 }, none, "u1");
    expect(reply).toContain("Za dużo zmian");
    expect(t.calls).toHaveLength(10);
  });

  test("with Redis down control commands are not limited", async () => {
    const store = createMemoryStore();
    store.increment = async () => {
      throw new Error("redis down");
    };
    const t = setup({ lock: store });
    t.areas.set("400", area);
    await t.voice(null, "400");
    t.calls.length = 0;
    for (let i = 0; i < 12; i++) await t.run("limit", { count: 5 }, none, "u1");
    expect(t.calls).toHaveLength(12);
  });

  test("every Discord edit carries an audit reason and a successful action is logged", async () => {
    const t = await withChannel();
    await t.run("lock", {}, none, "u1");
    expect(t.calls).toEqual(['everyone 1000 {"connect":false} (Party: lock by u1)']);
    expect(t.infos).toContainEqual({
      message: "Party control used",
      fields: { guildId, channelId: "1000", actor: "u1", action: "lock" },
    });
  });

  test("invite allows the member and refuses the caller, the bot and strangers", async () => {
    const t = await withChannel();
    expect((await t.run("invite", { user: "friend" }, none, "u1"))[0]).toContain("<@friend>");
    expect(t.calls).toEqual(["allow 1000 friend"]);
    for (const user of ["u1", "bot-self", "nobody"]) {
      expect((await t.run("invite", { user }, none, "u1"))[0]).toBeDefined();
    }
    expect(t.calls).toEqual(["allow 1000 friend"]);
  });

  test("block denies the member and disconnects them when they are inside", async () => {
    const t = await withChannel();
    t.addMember("1000", "friend");
    await t.run("block", { user: "friend" }, none, "u1");
    expect(t.calls).toEqual(["deny 1000 friend", "disconnect friend 1000"]);
    expect(t.discord.get("1000")?.has("friend")).toBe(false);
  });

  test("block refuses someone who can moderate", async () => {
    const t = await withChannel();
    const [reply] = await t.run("block", { user: "mod" }, none, "u1");
    expect(reply).toBe("Nie możesz zablokować moderatora.");
    expect(t.calls).toEqual([]);
  });

  test("block of someone outside only sets the overwrite", async () => {
    const t = await withChannel();
    await t.run("block", { user: "u2" }, none, "u1");
    expect(t.calls).toEqual(["deny 1000 u2"]);
  });

  test("block refuses the owner, the caller, the bot and strangers", async () => {
    const t = await withChannel();
    t.addMember("1000", "friend");
    t.managers.add("friend");
    // friend holds Manage Channels and tries to block the owner.
    expect((await t.run("block", { user: "u1" }, MANAGE_CHANNELS, "friend"))[0]).toContain(
      "właściciela",
    );
    await t.run("block", { user: "friend" }, MANAGE_CHANNELS, "friend");
    for (const user of ["bot-self", "nobody"]) await t.run("block", { user }, none, "u1");
    expect(t.calls).toEqual([]);
  });

  test("a non-owner without Manage Channels is refused", async () => {
    const t = await withChannel();
    t.addMember("1000", "friend");
    const [reply] = await t.run("lock", {}, none, "friend");
    expect(reply).toContain("właściciel");
    expect(t.calls).toEqual([]);
  });

  test("a member with Manage Channels controls a channel they do not own", async () => {
    const t = await withChannel();
    t.addMember("1000", "friend");
    t.managers.add("friend");
    await t.run("lock", {}, none, "friend");
    expect(t.calls).toEqual(['everyone 1000 {"connect":false} (Party: lock by friend)']);
  });

  test("Manage Channels is judged on the party channel, not on the command's channel", async () => {
    const t = await withChannel();
    t.addMember("1000", "friend");
    // The caller's permissions where the command was typed do not matter.
    const [reply] = await t.run("lock", {}, MANAGE_CHANNELS, "friend");
    expect(reply).toContain("właściciel");
    expect(t.calls).toEqual([]);
  });

  test("outside a party channel the answer says so and nothing changes", async () => {
    const t = await withChannel();
    t.discord.set("555", new Set(["u2"]));
    expect((await t.run("lock", {}, none, "u2"))[0]).toBe("Musisz być na swoim kanale party.");
    // Not in voice at all, and in the join channel (no party row).
    expect((await t.run("lock", {}, none, "stranger"))[0]).toBe(
      "Musisz być na swoim kanale party.",
    );
    expect((await t.run("lock", {}, MANAGE_CHANNELS, "u2"))[0]).toBe(
      "Musisz być na swoim kanale party.",
    );
    expect(t.calls).toEqual([]);
  });

  test("direct messages are refused", async () => {
    const t = setup();
    const ctx = createFakeContext({ subcommand: "lock", guildId: null });
    await executeCommand(t.module.commands?.[0] as never, ctx, silentLogger);
    expect(replyText(ctx.replies[0])).toContain("serwerze");
  });

  test("replies are ephemeral", async () => {
    const t = await withChannel();
    const ctx = createFakeContext({ subcommand: "hide", userId: "u1" });
    await executeCommand(t.module.commands?.[0] as never, ctx, silentLogger);
    expect(ctx.replies[0]).toMatchObject({ ephemeral: true });
  });

  test("a new channel gives its owner an allow overwrite", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    expect(t.calls).toEqual(["self 1000", "allow 1000 u1"]);
  });

  test("the bot gets its own overwrite so lock and hide never lock it out", async () => {
    const t = setup();
    t.areas.set("400", area);
    await t.voice(null, "400");
    expect(t.calls[0]).toBe("self 1000");
  });

  test("a failing owner or bot overwrite is logged and the channel is kept", async () => {
    for (const options of [{ allowFails: true }, { allowSelfFails: true }]) {
      const t = setup(options);
      t.areas.set("400", area);
      await t.voice(null, "400");
      expect(t.owned.size).toBe(1);
      expect(t.discord.has("1000")).toBe(true);
      expect(t.moves).toEqual([{ userId: "u1", channelId: "1000" }]);
      expect(t.warnings.length).toBeGreaterThan(0);
    }
  });

  test("ownership transfer gives the new owner access and clears the old one", async () => {
    const t = await withChannel();
    t.discord.get("1000")?.add("friend");
    await t.voice("1000", null);
    expect(t.owned.get("1000")?.ownerId).toBe("friend");
    expect(t.calls).toEqual(["allow 1000 friend", "clear 1000 u1"]);
  });
});
