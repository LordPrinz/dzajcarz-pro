import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { ChannelType, type Client } from "discord.js";
import { createGuildLookup, createTextChannels, createWelcomeSender } from "./welcome.ts";

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const CHANNEL = "400000000000000004";

function clientWithChannel(channel: unknown): Client {
  return { channels: { fetch: async () => channel } } as unknown as Client;
}

function textChannel(guildId: string, sent: unknown[] = []) {
  return {
    guildId,
    isTextBased: () => true,
    isDMBased: () => false,
    send: async (payload: unknown) => void sent.push(payload),
  };
}

describe("welcome sender", () => {
  test("posts in a text channel of the guild, pinging only the member", async () => {
    const sent: unknown[] = [];
    const sender = createWelcomeSender(clientWithChannel(textChannel(GUILD, sent)));
    await sender.send(GUILD, CHANNEL, "Hej", "5");
    expect(sent).toEqual([{ content: "Hej", allowedMentions: { users: ["5"] } }]);
  });

  test("refuses a channel of another guild", async () => {
    const sent: unknown[] = [];
    const sender = createWelcomeSender(clientWithChannel(textChannel(OTHER_GUILD, sent)));
    await expect(sender.send(GUILD, CHANNEL, "Hej", "5")).rejects.toThrow("not a text channel");
    expect(sent).toEqual([]);
  });

  test("refuses DM channels, non-text channels and missing channels", async () => {
    const dm = { ...textChannel(GUILD), isDMBased: () => true };
    const voice = { ...textChannel(GUILD), isTextBased: () => false };
    for (const channel of [dm, voice, null]) {
      const sender = createWelcomeSender(clientWithChannel(channel));
      await expect(sender.send(GUILD, CHANNEL, "Hej", "5")).rejects.toThrow();
    }
  });
});

describe("text channels", () => {
  function clientWithGuildChannel(channel: unknown): Client {
    const guild = { channels: { fetch: async () => channel } };
    return { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
  }

  test("accepts text and announcement channels of the guild", async () => {
    for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
      const channels = createTextChannels(clientWithGuildChannel({ guildId: GUILD, type }));
      expect(await channels.isTextChannelOf(GUILD, CHANNEL)).toBe(true);
    }
  });

  test("rejects voice channels, foreign channels and unknown guilds", async () => {
    const voice = createTextChannels(
      clientWithGuildChannel({ guildId: GUILD, type: ChannelType.GuildVoice }),
    );
    expect(await voice.isTextChannelOf(GUILD, CHANNEL)).toBe(false);
    const foreign = createTextChannels(
      clientWithGuildChannel({ guildId: OTHER_GUILD, type: ChannelType.GuildText }),
    );
    expect(await foreign.isTextChannelOf(GUILD, CHANNEL)).toBe(false);
    expect(await foreign.isTextChannelOf(OTHER_GUILD, CHANNEL)).toBe(false);
  });
});

describe("guild lookup", () => {
  test("logs the failure and returns null", async () => {
    const warnings: string[] = [];
    const client = {
      guilds: {
        fetch: async () => {
          throw new Error("Unknown Guild");
        },
      },
    } as unknown as Client;
    const lookup = createGuildLookup(client, {
      ...silentLogger,
      warn: (message) => void warnings.push(message),
    });
    expect(await lookup.describe(GUILD)).toBeNull();
    expect(warnings).toEqual(["Could not fetch the guild"]);
  });
});
