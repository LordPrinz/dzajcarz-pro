import { describe, expect, test } from "bun:test";
import { ChannelType, type Client, PermissionFlagsBits } from "discord.js";
import { createPartyPermissions } from "./party.ts";

const GUILD = "100000000000000001";
const CHANNEL = "400000000000000004";
const EVERYONE = GUILD;

function bitsOf(...flags: bigint[]) {
  const value = flags.reduce((a, b) => a | b, 0n);
  return { has: (flag: bigint) => (value & flag) === flag };
}

interface FakeMember {
  channelId: string | null;
  permissions?: bigint[];
  disconnects: string[];
}

function clientWith(member: FakeMember, parentOverwrite?: { allow: bigint[]; deny: bigint[] }) {
  const guildMember = {
    voice: {
      channelId: member.channelId,
      disconnect: async (reason: string) => void member.disconnects.push(reason),
    },
    permissions: { any: (flags: bigint[]) => flags.some((f) => member.permissions?.includes(f)) },
  };
  const channel = {
    type: ChannelType.GuildVoice,
    guildId: GUILD,
    guild: { roles: { everyone: { id: EVERYONE } } },
    parent: {
      permissionOverwrites: {
        cache: new Map(
          parentOverwrite
            ? [
                [
                  EVERYONE,
                  {
                    allow: bitsOf(...parentOverwrite.allow),
                    deny: bitsOf(...parentOverwrite.deny),
                  },
                ],
              ]
            : [],
        ),
      },
    },
    permissionsFor: () => bitsOf(...(member.permissions ?? [])),
  };
  return {
    user: { id: "bot" },
    channels: { fetch: async () => channel },
    guilds: { fetch: async () => ({ members: { fetch: async () => guildMember } }) },
  } as unknown as Client;
}

describe("party permissions adapter", () => {
  test("disconnect only pulls the member out of the given channel", async () => {
    const elsewhere: FakeMember = { channelId: "other", disconnects: [] };
    await createPartyPermissions(clientWith(elsewhere)).disconnect(GUILD, "5", CHANNEL, "why");
    expect(elsewhere.disconnects).toEqual([]);

    const inside: FakeMember = { channelId: CHANNEL, disconnects: [] };
    await createPartyPermissions(clientWith(inside)).disconnect(GUILD, "5", CHANNEL, "why");
    expect(inside.disconnects).toEqual(["why"]);
  });

  test("inheritedEveryone reads deny, allow and absence from the category", async () => {
    const member: FakeMember = { channelId: null, disconnects: [] };
    const read = (overwrite?: { allow: bigint[]; deny: bigint[] }) =>
      createPartyPermissions(clientWith(member, overwrite)).inheritedEveryone(CHANNEL);
    expect(await read()).toEqual({ connect: null, view: null });
    expect(
      await read({ allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }),
    ).toEqual({ connect: false, view: true });
  });

  test("lookupMember flags moderators", async () => {
    const lookup = (permissions: bigint[]) =>
      createPartyPermissions(
        clientWith({ channelId: null, permissions, disconnects: [] }),
      ).lookupMember(GUILD, "5");
    expect(await lookup([])).toEqual({ self: false, moderator: false });
    expect(await lookup([PermissionFlagsBits.MoveMembers])).toEqual({
      self: false,
      moderator: true,
    });
  });

  test("canManage asks the channel, overwrites included", async () => {
    const permissions = (flags: bigint[]) =>
      createPartyPermissions(clientWith({ channelId: null, permissions: flags, disconnects: [] }));
    expect(await permissions([]).canManage(GUILD, "5", CHANNEL)).toBe(false);
    expect(
      await permissions([PermissionFlagsBits.ManageChannels]).canManage(GUILD, "5", CHANNEL),
    ).toBe(true);
  });
});
