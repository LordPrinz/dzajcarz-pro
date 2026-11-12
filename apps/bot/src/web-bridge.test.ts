import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { createMemoryPubSub } from "@dzajcarz/kv";
import {
  createBotClient,
  EVENT_CHANNEL,
  EVENTS,
  EventEnvelope,
  type GuildSummary,
} from "@dzajcarz/web-protocol";
import {
  type ArchiveControl,
  type ReadingControl,
  startWebBridge,
  type WritingControl,
} from "./web-bridge.ts";

const guilds: GuildSummary[] = [
  { id: "100000000000000001", name: "Alfa", iconUrl: null, memberCount: 3 },
  {
    id: "200000000000000002",
    name: "Beta",
    iconUrl: "https://cdn.discordapp.com/icons/200000000000000002/b.png",
    memberCount: 9,
  },
];
const STATUS = { guilds: 2, startedAt: "2026-11-11T10:00:00.000Z" };
const GUILD = "100000000000000001";
const CHANNEL = "300000000000000003";

const archive: ArchiveControl = {
  setGuild: async (request) => request,
  setDm: async (request) => request,
  backfill: async () => ({ status: "ok", fetched: 2, stored: 1, oldestId: CHANNEL, done: true }),
};
const reading: ReadingControl = {
  channelMessages: async () => ({ status: "no_access" }),
  dmList: async () => ({ channels: [], truncated: false }),
  resolveNames: async ({ users }) => ({
    users: Object.fromEntries(users.map((id) => [id, "Ola"])),
    roles: {},
    channels: {},
  }),
};
const writing: WritingControl = {
  "channel.info": async () => ({ status: "unknown_channel" }),
  "message.send": async () => ({ status: "ok", messageId: "500000000000000005" }),
  "message.edit": async () => ({ status: "rejected", reason: "not_own" }),
  "message.delete": async () => ({ status: "ok" }),
  "reaction.add": async () => ({ status: "ok" }),
  "reaction.remove": async () => ({ status: "ok" }),
  "members.search": async () => ({ members: [] }),
  "dm.open": async () => ({ status: "rejected", reason: "unknown_user" }),
};
const listChannels = (guildId: string) =>
  guildId === GUILD
    ? {
        channels: [{ id: CHANNEL, name: "ogólny", kind: "text" as const, parentId: null }],
        truncated: false,
      }
    : null;

function setup(listGuilds: () => GuildSummary[] = () => guilds, logger = silentLogger) {
  const pubsub = createMemoryPubSub();
  const client = createBotClient({ pubsub, timeoutMs: 50, logger: silentLogger });
  return {
    pubsub,
    client,
    start: () =>
      startWebBridge({
        pubsub,
        listGuilds,
        listChannels,
        archive,
        reading,
        writing,
        botStatus: () => STATUS,
        logger,
        heartbeatMs: 20,
      }),
  };
}

describe("startWebBridge", () => {
  test("guilds.list returns what listGuilds returns", async () => {
    const { client, start } = setup();
    await client.start();
    await start();
    expect(await client.request("guilds.list", {})).toEqual({ ok: true, data: guilds });
  });

  test("guilds.channels answers the list, or null for a guild the bot is not in", async () => {
    const { client, start } = setup();
    await client.start();
    await start();
    expect(await client.request("guilds.channels", { guildId: GUILD })).toEqual({
      ok: true,
      data: listChannels(GUILD),
    });
    expect(await client.request("guilds.channels", { guildId: "200000000000000002" })).toEqual({
      ok: true,
      data: null,
    });
  });

  test("the archive commands reach the archive control", async () => {
    const { client, start } = setup();
    await client.start();
    await start();
    const settings = { guildId: GUILD, enabled: true, excludedChannelIds: [CHANNEL] };
    expect(await client.request("archive.guild.set", settings)).toEqual({
      ok: true,
      data: settings,
    });
    expect(await client.request("archive.dm.set", { enabled: true })).toEqual({
      ok: true,
      data: { enabled: true },
    });
    expect(await client.request("archive.backfill", { channelId: CHANNEL })).toEqual({
      ok: true,
      data: { status: "ok", fetched: 2, stored: 1, oldestId: CHANNEL, done: true },
    });
  });

  test("the reading commands reach the reading control", async () => {
    const { client, start } = setup();
    await client.start();
    await start();
    expect(await client.request("channel.messages", { channelId: CHANNEL, limit: 10 })).toEqual({
      ok: true,
      data: { status: "no_access" },
    });
    expect(await client.request("dms.list", {})).toEqual({
      ok: true,
      data: { channels: [], truncated: false },
    });
    expect(
      await client.request("names.resolve", {
        guildId: null,
        users: [CHANNEL],
        roles: [],
        channels: [],
      }),
    ).toEqual({ ok: true, data: { users: { [CHANNEL]: "Ola" }, roles: {}, channels: {} } });
  });

  test("the writing commands reach the writing control", async () => {
    const { client, start } = setup();
    await client.start();
    await start();
    expect(
      await client.request("message.send", {
        channelId: CHANNEL,
        content: "hej",
        allowMentions: false,
        nonce: "n1",
      }),
    ).toEqual({ ok: true, data: { status: "ok", messageId: "500000000000000005" } });
    expect(
      await client.request("message.edit", {
        channelId: CHANNEL,
        messageId: CHANNEL,
        content: "x",
        allowMentions: false,
      }),
    ).toEqual({ ok: true, data: { status: "rejected", reason: "not_own" } });
    expect(await client.request("dm.open", { userId: CHANNEL })).toEqual({
      ok: true,
      data: { status: "rejected", reason: "unknown_user" },
    });
  });

  test("publishEvent reaches the panel's event listeners", async () => {
    const { client, start } = setup();
    await client.start();
    const bridge = await start();
    const seen: unknown[] = [];
    client.onEvent((event) => seen.push(event));
    await bridge.publishEvent("message.deleted", {
      guildId: GUILD,
      channelId: CHANNEL,
      ids: [CHANNEL],
    });
    expect(seen).toEqual([
      {
        event: "message.deleted",
        payload: { guildId: GUILD, channelId: CHANNEL, ids: [CHANNEL] },
        at: expect.any(Number),
      },
    ]);
  });

  test("onReady publishes a valid bot.status at once and then on every beat", async () => {
    const { pubsub, start } = setup();
    const seen: unknown[] = [];
    await pubsub.subscribe(EVENT_CHANNEL, (raw) => seen.push(JSON.parse(raw)));
    const bridge = await start();
    expect(seen).toHaveLength(0);
    bridge.onReady();
    bridge.onReady();
    await Bun.sleep(70);
    await bridge.stop();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const raw of seen) {
      const envelope = EventEnvelope.parse(raw);
      expect(envelope.event).toBe("bot.status");
      expect(EVENTS["bot.status"].parse(envelope.payload)).toEqual(STATUS);
    }
  });

  test("calling onReady twice starts one heartbeat, not two", async () => {
    const pubsub = createMemoryPubSub();
    const seen: string[] = [];
    await pubsub.subscribe(EVENT_CHANNEL, (raw) => seen.push(raw));
    const bridge = await startWebBridge({
      pubsub,
      listGuilds: () => guilds,
      listChannels,
      archive,
      reading,
      writing,
      botStatus: () => STATUS,
      logger: silentLogger,
      heartbeatMs: 60_000,
    });
    bridge.onReady();
    bridge.onReady();
    await Bun.sleep(20);
    await bridge.stop();
    expect(seen).toHaveLength(1);
  });

  test("stop unsubscribes and ends the heartbeat", async () => {
    const { pubsub, client, start } = setup();
    await client.start();
    const bridge = await start();
    bridge.onReady();
    await bridge.stop();
    expect(await client.request("guilds.list", {})).toEqual({ ok: false, reason: "unavailable" });
    const seen: string[] = [];
    await pubsub.subscribe(EVENT_CHANNEL, (raw) => seen.push(raw));
    await Bun.sleep(60);
    expect(seen).toEqual([]);
  });

  test("a throwing listGuilds is an error for the web and is logged", async () => {
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      error: (message: string) => void lines.push(message),
    };
    const { client, start } = setup(() => {
      throw new Error("cache broke");
    }, logger);
    await client.start();
    await start();
    expect(await client.request("guilds.list", {})).toMatchObject({ ok: false, reason: "error" });
    expect(lines).toContain("Command handler failed");
  });
});
