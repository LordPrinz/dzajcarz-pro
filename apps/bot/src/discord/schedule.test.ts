import { describe, expect, test } from "bun:test";
import { ChannelType, type Client, Collection } from "discord.js";
import { createScheduleVoice } from "./schedule.ts";

const GUILD = "100000000000000001";
const AFK = "400000000000000009";

function channel(
  id: string,
  options: { joinable?: boolean; speakable?: boolean; type?: ChannelType },
) {
  const members = new Collection([
    ["200000000000000001", { user: { bot: false } }],
    ["200000000000000002", { user: { bot: true } }],
  ]);
  return {
    id,
    type: options.type ?? ChannelType.GuildVoice,
    joinable: options.joinable ?? true,
    speakable: options.speakable ?? true,
    members,
  };
}

function clientWith(channels: ReturnType<typeof channel>[], afkChannelId: string | null) {
  const guild = {
    afkChannelId,
    channels: { cache: new Collection(channels.map((c) => [c.id, c])) },
  };
  return { guilds: { cache: new Collection([[GUILD, guild]]) } } as unknown as Client;
}

describe("schedule voice", () => {
  test("lists only voice channels the bot may join and speak in, counting humans", async () => {
    const voice = createScheduleVoice(
      clientWith(
        [
          channel("400000000000000001", {}),
          channel("400000000000000002", { joinable: false }),
          channel("400000000000000003", { speakable: false }),
          channel("400000000000000004", { type: ChannelType.GuildStageVoice }),
        ],
        null,
      ),
    );
    expect(await voice.crowds(GUILD)).toEqual([{ channelId: "400000000000000001", humans: 1 }]);
  });

  test("exposes the server's AFK channel", () => {
    expect(createScheduleVoice(clientWith([], AFK)).afkChannelId(GUILD)).toBe(AFK);
    expect(createScheduleVoice(clientWith([], null)).afkChannelId(GUILD)).toBeNull();
    expect(createScheduleVoice(clientWith([], AFK)).afkChannelId("100000000000000002")).toBeNull();
  });
});
