import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { createGuildChannels } from "./guild-channels.ts";

const GUILD = "100000000000000001";

function clientWith(channels: Record<string, { guildId: string; thread?: boolean }>) {
  const guild = {
    channels: {
      fetch: async (id: string) => {
        const channel = channels[id];
        if (!channel) throw new Error("Unknown Channel");
        return { guildId: channel.guildId, isThread: () => channel.thread ?? false };
      },
    },
  };
  return {
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;
}

describe("guild channels adapter", () => {
  const channels = createGuildChannels(
    clientWith({ "1": { guildId: GUILD }, "2": { guildId: GUILD, thread: true } }),
  );

  test("a channel of the guild belongs to it", async () => {
    expect(await channels.belongsTo(GUILD, "1")).toBe(true);
  });

  test("an unknown channel or a guild the bot is not in is false, not an error", async () => {
    expect(await channels.belongsTo(GUILD, "404")).toBe(false);
    expect(await channels.belongsTo("999", "1")).toBe(false);
  });

  test("tells threads from channels", async () => {
    expect(await channels.isThread(GUILD, "2")).toBe(true);
    expect(await channels.isThread(GUILD, "1")).toBe(false);
    expect(await channels.isThread(GUILD, "404")).toBe(false);
    expect(await channels.isThread("999", "2")).toBe(false);
  });
});
