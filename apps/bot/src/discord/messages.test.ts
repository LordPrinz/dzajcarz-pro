import { describe, expect, test } from "bun:test";
import { type Client, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import { createMessageChannels, createScheduledMessageSender } from "./messages.ts";
import { NO_MENTIONS } from "./reply.ts";

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const CHANNEL = "400000000000000004";
const MEMBER = "200000000000000005";

function textChannel(guildId: string, sent: unknown[] = []) {
  return {
    guildId,
    isTextBased: () => true,
    isDMBased: () => false,
    send: async (payload: unknown) => void sent.push(payload),
  };
}

function discordError(code: number): Error {
  return Object.assign(new Error(`Discord error ${code}`), { code });
}

function clientWith(options: {
  channel?: unknown;
  fetchChannel?: () => Promise<unknown>;
  member?: () => Promise<unknown>;
  guildName?: string;
}): Client {
  const guild = {
    name: options.guildName ?? "Dżajcarnia",
    members: { fetch: options.member ?? (async () => null) },
  };
  return {
    channels: { fetch: options.fetchChannel ?? (async () => options.channel ?? null) },
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;
}

function member(sent: unknown[], options: { bot?: boolean; send?: () => Promise<void> } = {}) {
  return async () => ({
    user: { bot: options.bot ?? false },
    send: options.send ?? (async (payload: unknown) => void sent.push(payload)),
  });
}

describe("scheduled message sender: channels", () => {
  test("posts with no mentions at all", async () => {
    const sent: unknown[] = [];
    const sender = createScheduledMessageSender(clientWith({ channel: textChannel(GUILD, sent) }));
    await sender.toChannel(GUILD, CHANNEL, "@everyone hej");
    expect(sent).toEqual([{ content: "@everyone hej", allowedMentions: NO_MENTIONS }]);
  });

  test("reports a channel Discord no longer knows as gone", async () => {
    const fetchChannel = async () => {
      throw discordError(RESTJSONErrorCodes.UnknownChannel);
    };
    const sender = createScheduledMessageSender(clientWith({ fetchChannel }));
    expect(await sender.toChannel(GUILD, CHANNEL, "x")).toBe("gone");
  });

  test("any other Discord error, such as Missing Access, still rejects", async () => {
    const fetchChannel = async () => {
      throw discordError(RESTJSONErrorCodes.MissingAccess);
    };
    const sender = createScheduledMessageSender(clientWith({ fetchChannel }));
    await expect(sender.toChannel(GUILD, CHANNEL, "x")).rejects.toThrow("Discord error 50001");
  });

  test("refuses a channel of another guild, a DM channel, a voice channel and a missing one", async () => {
    const sent: unknown[] = [];
    const foreign = textChannel(OTHER_GUILD, sent);
    const dm = { ...textChannel(GUILD, sent), isDMBased: () => true };
    const voice = { ...textChannel(GUILD, sent), isTextBased: () => false };
    for (const channel of [foreign, dm, voice, null]) {
      const sender = createScheduledMessageSender(clientWith({ channel }));
      await expect(sender.toChannel(GUILD, CHANNEL, "x")).rejects.toThrow();
    }
    expect(sent).toEqual([]);
  });
});

describe("scheduled message sender: DMs", () => {
  test("lets the recipient be pinged and nobody else, with the buttons", async () => {
    const sent: unknown[] = [];
    const sender = createScheduledMessageSender(clientWith({ member: member(sent) }));
    const delivered = await sender.toMember(GUILD, MEMBER, `Hej <@${MEMBER}>`, [
      [
        {
          type: "button",
          customId: `messages:optout:${MEMBER}:${GUILD}`,
          label: "Nie wysyłaj mi więcej",
        },
      ],
    ]);
    expect(delivered).toBe(true);
    expect(sent).toHaveLength(1);
    const payload = sent[0] as { content: string; allowedMentions: unknown; components: unknown[] };
    expect(payload.content).toBe(`Hej <@${MEMBER}>`);
    expect(payload.allowedMentions).toEqual({ users: [MEMBER] });
    expect(payload.components).toHaveLength(1);
  });

  test("closed DMs resolve false; other failures throw", async () => {
    const closed = createScheduledMessageSender(
      clientWith({
        member: member([], {
          send: async () => {
            throw discordError(RESTJSONErrorCodes.CannotSendMessagesToThisUser);
          },
        }),
      }),
    );
    expect(await closed.toMember(GUILD, MEMBER, "x", [])).toBe(false);
    const broken = createScheduledMessageSender(
      clientWith({
        member: member([], {
          send: async () => {
            throw discordError(RESTJSONErrorCodes.MissingAccess);
          },
        }),
      }),
    );
    await expect(broken.toMember(GUILD, MEMBER, "x", [])).rejects.toThrow();
  });

  test("refuses a guild the bot is not in", async () => {
    const sender = createScheduledMessageSender(clientWith({ member: member([]) }));
    await expect(sender.toMember(OTHER_GUILD, MEMBER, "x", [])).rejects.toThrow("not in guild");
  });
});

describe("scheduled message sender: lookups", () => {
  test("memberStatus tells members, bots and people who are not there apart", async () => {
    expect(
      await createScheduledMessageSender(clientWith({ member: member([]) })).memberStatus(
        GUILD,
        MEMBER,
      ),
    ).toBe("member");
    expect(
      await createScheduledMessageSender(
        clientWith({ member: member([], { bot: true }) }),
      ).memberStatus(GUILD, MEMBER),
    ).toBe("bot");
    const gone = createScheduledMessageSender(
      clientWith({
        member: async () => {
          throw discordError(RESTJSONErrorCodes.UnknownMember);
        },
      }),
    );
    expect(await gone.memberStatus(GUILD, MEMBER)).toBe("absent");
    expect(await gone.memberStatus(OTHER_GUILD, MEMBER)).toBe("absent");
  });

  test("memberStatus rethrows a failure that says nothing about membership", async () => {
    const sender = createScheduledMessageSender(
      clientWith({
        member: async () => {
          throw new Error("network down");
        },
      }),
    );
    await expect(sender.memberStatus(GUILD, MEMBER)).rejects.toThrow("network down");
  });

  test("guildName comes from the cache; an unknown guild is null", async () => {
    const sender = createScheduledMessageSender(clientWith({}));
    expect(await sender.guildName(GUILD)).toBe("Dżajcarnia");
    expect(await sender.guildName(OTHER_GUILD)).toBeNull();
  });
});

describe("message channels", () => {
  const ME = { id: "300000000000000001" };

  function clientWithPermissions(
    granted: bigint[] | null,
    options: { me?: unknown; channel?: boolean } = {},
  ): { client: Client; asked: unknown[] } {
    const asked: unknown[] = [];
    const channel = {
      guildId: GUILD,
      permissionsFor: (who: unknown) => {
        asked.push(who);
        return granted === null
          ? null
          : { has: (bits: bigint[]) => bits.every((bit) => granted.includes(bit)) };
      },
    };
    const guild = {
      members: { me: options.me === undefined ? ME : options.me, fetchMe: async () => ME },
      channels: { fetch: async () => (options.channel === false ? null : channel) },
    };
    return { client: { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client, asked };
  }

  const both = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

  test("the bot may post when it can view the channel and send messages there", async () => {
    const { client, asked } = clientWithPermissions(both);
    expect(await createMessageChannels(client).botCanPostIn(GUILD, CHANNEL)).toBe(true);
    expect(asked).toEqual([ME]);
  });

  test("missing either permission, the channel or the guild means no", async () => {
    const cases = [
      clientWithPermissions([PermissionFlagsBits.ViewChannel]),
      clientWithPermissions([PermissionFlagsBits.SendMessages]),
      clientWithPermissions(null),
      clientWithPermissions(both, { channel: false }),
    ];
    for (const { client } of cases) {
      expect(await createMessageChannels(client).botCanPostIn(GUILD, CHANNEL)).toBe(false);
    }
    const { client } = clientWithPermissions(both);
    expect(await createMessageChannels(client).botCanPostIn(OTHER_GUILD, CHANNEL)).toBe(false);
  });

  test("fetches the bot's own member when it is not cached", async () => {
    const { client, asked } = clientWithPermissions(both, { me: null });
    expect(await createMessageChannels(client).botCanPostIn(GUILD, CHANNEL)).toBe(true);
    expect(asked).toEqual([ME]);
  });
});
