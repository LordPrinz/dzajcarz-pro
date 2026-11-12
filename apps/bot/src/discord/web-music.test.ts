import { describe, expect, test } from "bun:test";
import { MAX_VOICE_CHANNELS } from "@dzajcarz/web-protocol";
import { type Client, PermissionFlagsBits } from "discord.js";
import { createVoiceDirectory } from "./web-music.ts";

const GUILD = "100000000000000001";
const ME = { id: "100000000000000099" };

interface FakeVoice {
  id: string;
  name: string;
  rawPosition: number;
  parentId: string | null;
  humans?: number;
  bots?: number;
  joinable?: boolean;
  /** Permissions the bot lacks there; it has all it needs otherwise. */
  missing?: bigint[];
}

function clientWith(voice: FakeVoice[], categories: { id: string; rawPosition: number }[] = []) {
  const cache = new Map<string, unknown>();
  const guild = { id: GUILD, members: { me: ME }, channels: { cache } };
  for (const category of categories) {
    cache.set(category.id, { ...category, isVoiceBased: () => false });
  }
  for (const channel of voice) {
    const members = [
      ...Array.from({ length: channel.humans ?? 0 }, () => ({ user: { bot: false } })),
      ...Array.from({ length: channel.bots ?? 0 }, () => ({ user: { bot: true } })),
    ];
    cache.set(channel.id, {
      ...channel,
      guild,
      isVoiceBased: () => true,
      get parent() {
        return channel.parentId ? cache.get(channel.parentId) : null;
      },
      joinable: channel.joinable ?? true,
      permissionsFor: (member: unknown) =>
        member === ME
          ? {
              has: (flags: bigint[]) =>
                flags.every((flag) => !(channel.missing ?? []).includes(flag)),
            }
          : null,
      members: {
        filter: (keep: (member: { user: { bot: boolean } }) => boolean) => ({
          size: members.filter(keep).length,
        }),
      },
    });
  }
  cache.set("200000000000000001", { id: "200000000000000001", isVoiceBased: () => false });
  return { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
}

describe("voice directory", () => {
  test("lists voice channels by category and position with listeners, bots left out", () => {
    const directory = createVoiceDirectory(
      clientWith(
        [
          {
            id: "400000000000000003",
            name: "Później",
            rawPosition: 0,
            parentId: "300000000000000002",
          },
          {
            id: "400000000000000002",
            name: "Drugi",
            rawPosition: 1,
            parentId: null,
            humans: 2,
            bots: 1,
          },
          { id: "400000000000000001", name: "Pierwszy", rawPosition: 0, parentId: null },
        ],
        [{ id: "300000000000000002", rawPosition: 5 }],
      ),
    );
    expect(directory.list(GUILD)).toEqual({
      channels: [
        {
          id: "400000000000000001",
          name: "Pierwszy",
          parentId: null,
          listeners: 0,
          joinable: true,
        },
        { id: "400000000000000002", name: "Drugi", parentId: null, listeners: 2, joinable: true },
        {
          id: "400000000000000003",
          name: "Później",
          parentId: "300000000000000002",
          listeners: 0,
          joinable: true,
        },
      ],
      truncated: false,
    });
    expect(directory.list("100000000000000777")).toBeNull();
  });

  test("a channel the bot may not join, speak or post the panel in is not joinable", () => {
    const directory = createVoiceDirectory(
      clientWith([
        {
          id: "400000000000000001",
          name: "Pełny",
          rawPosition: 0,
          parentId: null,
          joinable: false,
        },
        {
          id: "400000000000000002",
          name: "Cisza",
          rawPosition: 1,
          parentId: null,
          missing: [PermissionFlagsBits.Speak],
        },
        { id: "400000000000000003", name: "Ok", rawPosition: 2, parentId: null },
        {
          id: "400000000000000004",
          name: "Bez czatu",
          rawPosition: 3,
          parentId: null,
          missing: [PermissionFlagsBits.EmbedLinks],
        },
      ]),
    );
    expect(directory.check(GUILD, "400000000000000001")).toBe("no_connect");
    expect(directory.check(GUILD, "400000000000000002")).toBe("no_connect");
    expect(directory.check(GUILD, "400000000000000003")).toBe("ok");
    expect(directory.check(GUILD, "400000000000000004")).toBe("no_connect");
    expect(directory.check(GUILD, "200000000000000001")).toBe("unknown_channel");
    expect(directory.check(GUILD, "400000000000000777")).toBe("unknown_channel");
    expect(directory.check("100000000000000777", "400000000000000003")).toBe("unknown_channel");
  });

  test("past the limit the list is cut and says so", () => {
    const many = Array.from({ length: MAX_VOICE_CHANNELS + 5 }, (_, i) => ({
      id: String(400000000000000000n + BigInt(i)),
      name: `K${i}`,
      rawPosition: i,
      parentId: null,
    }));
    const listed = createVoiceDirectory(clientWith(many)).list(GUILD);
    expect(listed?.channels).toHaveLength(MAX_VOICE_CHANNELS);
    expect(listed?.truncated).toBe(true);
  });
});
