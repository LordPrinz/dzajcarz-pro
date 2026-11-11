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
import { startWebBridge } from "./web-bridge.ts";

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

function setup(listGuilds: () => GuildSummary[] = () => guilds, logger = silentLogger) {
  const pubsub = createMemoryPubSub();
  const client = createBotClient({ pubsub, timeoutMs: 50, logger: silentLogger });
  return {
    pubsub,
    client,
    start: () =>
      startWebBridge({ pubsub, listGuilds, botStatus: () => STATUS, logger, heartbeatMs: 20 }),
  };
}

describe("startWebBridge", () => {
  test("guilds.list returns what listGuilds returns", async () => {
    const { client, start } = setup();
    await client.start();
    await start();
    expect(await client.request("guilds.list", {})).toEqual({ ok: true, data: guilds });
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
