import { describe, expect, test } from "bun:test";
import { type Client, RESTJSONErrorCodes } from "discord.js";
import { createBirthdayMembers, createBirthdaySender } from "./birthday.ts";
import { NO_MENTIONS } from "./reply.ts";

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const CHANNEL = "400000000000000004";
const MEMBER = "200000000000000005";

function discordError(code: number): Error {
  return Object.assign(new Error(`Discord error ${code}`), { code });
}

function textChannel(guildId: string, sent: unknown[] = []) {
  return {
    guildId,
    isTextBased: () => true,
    isDMBased: () => false,
    send: async (payload: unknown) => void sent.push(payload),
  };
}

const rejecting = (code: number) => async () => {
  throw discordError(code);
};

function client(options: {
  fetchChannel?: () => Promise<unknown>;
  fetchUser?: () => Promise<unknown>;
  fetchMember?: () => Promise<unknown>;
}): Client {
  const guild = { name: "Dżajsy", members: { fetch: options.fetchMember ?? (async () => null) } };
  return {
    channels: { fetch: options.fetchChannel ?? (async () => null) },
    users: { fetch: options.fetchUser ?? (async () => null) },
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;
}

describe("birthday sender: channels", () => {
  test("posts in a text channel of the guild, pinging only the member", async () => {
    const sent: unknown[] = [];
    const sender = createBirthdaySender(
      client({ fetchChannel: async () => textChannel(GUILD, sent) }),
    );
    expect(await sender.toChannel(GUILD, CHANNEL, "@everyone sto lat", MEMBER)).toBe("sent");
    expect(sent).toEqual([{ content: "@everyone sto lat", allowedMentions: { users: [MEMBER] } }]);
  });

  test("a foreign, DM, voice or missing channel is gone, and nothing is sent", async () => {
    const sent: unknown[] = [];
    const channels = [
      textChannel(OTHER_GUILD, sent),
      { ...textChannel(GUILD, sent), isDMBased: () => true },
      { ...textChannel(GUILD, sent), isTextBased: () => false },
      null,
    ];
    for (const channel of channels) {
      const sender = createBirthdaySender(client({ fetchChannel: async () => channel }));
      expect(await sender.toChannel(GUILD, CHANNEL, "x", MEMBER)).toBe("gone");
    }
    expect(sent).toEqual([]);
  });

  test("unknown channel, missing access and missing permissions are gone; anything else throws", async () => {
    for (const code of [
      RESTJSONErrorCodes.UnknownChannel,
      RESTJSONErrorCodes.MissingAccess,
      RESTJSONErrorCodes.MissingPermissions,
    ]) {
      const sender = createBirthdaySender(client({ fetchChannel: rejecting(code) }));
      expect(await sender.toChannel(GUILD, CHANNEL, "x", MEMBER)).toBe("gone");
    }
    const sender = createBirthdaySender(client({ fetchChannel: rejecting(0) }));
    await expect(sender.toChannel(GUILD, CHANNEL, "x", MEMBER)).rejects.toThrow("Discord error 0");
  });
});

describe("birthday sender: DMs", () => {
  test("DMs the user with no mentions", async () => {
    const sent: unknown[] = [];
    const user = { send: async (payload: unknown) => void sent.push(payload) };
    const sender = createBirthdaySender(client({ fetchUser: async () => user }));
    expect(await sender.toUser(MEMBER, "Sto lat")).toBe("sent");
    expect(sent).toEqual([{ content: "Sto lat", allowedMentions: NO_MENTIONS }]);
  });

  test("closed DMs and a deleted account are closed; anything else throws", async () => {
    const closed = { send: rejecting(RESTJSONErrorCodes.CannotSendMessagesToThisUser) };
    expect(
      await createBirthdaySender(client({ fetchUser: async () => closed })).toUser(MEMBER, "x"),
    ).toBe("closed");
    const deleted = createBirthdaySender(
      client({ fetchUser: rejecting(RESTJSONErrorCodes.UnknownUser) }),
    );
    expect(await deleted.toUser(MEMBER, "x")).toBe("closed");
    const down = createBirthdaySender(client({ fetchUser: rejecting(0) }));
    await expect(down.toUser(MEMBER, "x")).rejects.toThrow("Discord error 0");
  });
});

describe("birthday members", () => {
  test("a member's display name; null for bots, non-members and unknown servers", async () => {
    const person = { displayName: "Ola", user: { bot: false } };
    const bot = { displayName: "Bot", user: { bot: true } };
    expect(
      await createBirthdayMembers(client({ fetchMember: async () => person })).displayName(
        GUILD,
        MEMBER,
      ),
    ).toBe("Ola");
    expect(
      await createBirthdayMembers(client({ fetchMember: async () => bot })).displayName(
        GUILD,
        MEMBER,
      ),
    ).toBeNull();
    for (const code of [RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser]) {
      const members = createBirthdayMembers(client({ fetchMember: rejecting(code) }));
      expect(await members.displayName(GUILD, MEMBER)).toBeNull();
    }
    expect(await createBirthdayMembers(client({})).displayName(OTHER_GUILD, MEMBER)).toBeNull();
    const down = createBirthdayMembers(client({ fetchMember: rejecting(0) }));
    await expect(down.displayName(GUILD, MEMBER)).rejects.toThrow("Discord error 0");
  });

  test("the guild's name, or null for a server the bot does not know", async () => {
    const members = createBirthdayMembers(client({}));
    expect(await members.guildName(GUILD)).toBe("Dżajsy");
    expect(await members.guildName(OTHER_GUILD)).toBeNull();
  });
});
