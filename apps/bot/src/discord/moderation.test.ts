import { describe, expect, test } from "bun:test";
import { UserError } from "@dzajcarz/core";
import { type Client, RESTJSONErrorCodes, SnowflakeUtil } from "discord.js";
import {
  BOT_MISSING_PERMISSIONS,
  createModerationGuild,
  MEMBER_GONE,
  NOT_A_TEXT_CHANNEL,
  UNKNOWN_USER,
} from "./moderation.ts";
import { NO_MENTIONS } from "./reply.ts";

const GUILD = "100000000000000001";
const CHANNEL = "300000000000000003";
const NOW = Date.UTC(2026, 10, 9, 12);
const DAY = 86_400_000;

function discordError(code: number): Error {
  return Object.assign(new Error(`Discord error ${code}`), { code });
}

/** A message id created `ageMs` before NOW; `seq` keeps ids of the same age apart. */
function idAged(ageMs: number, seq = 0): string {
  return (SnowflakeUtil.generate({ timestamp: NOW - ageMs }).valueOf() + BigInt(seq)).toString();
}

function fakeMember(id: string, extra: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    member: {
      id,
      roles: { highest: { position: 4 } },
      permissions: { bitfield: 1n << 2n },
      isCommunicationDisabled: () => false,
      kick: async (...args: unknown[]) => void calls.push(["kick", ...args]),
      timeout: async (...args: unknown[]) => void calls.push(["timeout", ...args]),
      ...extra,
    },
  };
}

function guildClient({
  members = {} as Record<string, unknown>,
  fetchError,
  banError,
  me,
}: {
  members?: Record<string, unknown>;
  fetchError?: unknown;
  banError?: unknown;
  me?: unknown;
} = {}) {
  const bans: unknown[][] = [];
  const guild = {
    name: "Dżajcownia",
    ownerId: "900000000000000009",
    members: {
      me,
      fetchMe: async () => members.me,
      fetch: async (id: string) => {
        if (fetchError) throw fetchError;
        const found = members[id];
        if (!found) throw discordError(RESTJSONErrorCodes.UnknownMember);
        return found;
      },
    },
    bans: {
      create: async (...args: unknown[]) => {
        if (banError) throw banError;
        bans.push(args);
      },
    },
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  return { client, bans };
}

describe("members", () => {
  test("describes a member by role position, ownership, guild permissions and timeout", async () => {
    const { member } = fakeMember("5", { isCommunicationDisabled: () => true });
    const owner = fakeMember("900000000000000009").member;
    const { client } = guildClient({ members: { "5": member, "900000000000000009": owner } });
    const guild = createModerationGuild(client);
    expect(await guild.member(GUILD, "5")).toEqual({
      id: "5",
      isOwner: false,
      topRole: 4,
      permissions: 1n << 2n,
      timedOut: true,
    });
    expect((await guild.member(GUILD, "900000000000000009"))?.isOwner).toBe(true);
  });

  test("Unknown Member and Unknown User mean not a member", async () => {
    for (const code of [RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser]) {
      const { client } = guildClient({ fetchError: discordError(code) });
      expect(await createModerationGuild(client).member(GUILD, "5")).toBeNull();
    }
  });

  test("other lookup failures are thrown", async () => {
    const { client } = guildClient({ fetchError: discordError(500) });
    await expect(createModerationGuild(client).member(GUILD, "5")).rejects.toThrow();
  });

  test("self uses the cached bot member and fetches it when the cache is empty", async () => {
    const cached = fakeMember("4").member;
    expect((await createModerationGuild(guildClient({ me: cached }).client).self(GUILD)).id).toBe(
      "4",
    );
    const fetched = fakeMember("4").member;
    const { client } = guildClient({ members: { me: fetched } });
    expect((await createModerationGuild(client).self(GUILD)).id).toBe("4");
  });
});

describe("actions", () => {
  test("ban goes through the guild's bans by id with the audit reason", async () => {
    const { client, bans } = guildClient();
    await createModerationGuild(client).ban(GUILD, "6", "tester: spam");
    expect(bans).toEqual([["6", { reason: "tester: spam" }]]);
  });

  test("kick, timeout and untimeout act on the member", async () => {
    const { member, calls } = fakeMember("5");
    const guild = createModerationGuild(guildClient({ members: { "5": member } }).client);
    await guild.kick(GUILD, "5", "r1");
    await guild.timeout(GUILD, "5", 60_000, "r2");
    await guild.untimeout(GUILD, "5", "r3");
    expect(calls).toEqual([
      ["kick", "r1"],
      ["timeout", 60_000, "r2"],
      ["timeout", null, "r3"],
    ]);
  });

  test("Missing Permissions becomes a UserError the moderator can act on", async () => {
    const refused = fakeMember("5", {
      kick: async () => {
        throw discordError(RESTJSONErrorCodes.MissingPermissions);
      },
      timeout: async () => {
        throw discordError(RESTJSONErrorCodes.MissingPermissions);
      },
    }).member;
    const guild = createModerationGuild(
      guildClient({
        members: { "5": refused },
        banError: discordError(RESTJSONErrorCodes.MissingPermissions),
      }).client,
    );
    for (const action of [
      () => guild.ban(GUILD, "5", "r"),
      () => guild.kick(GUILD, "5", "r"),
      () => guild.timeout(GUILD, "5", 1000, "r"),
      () => guild.untimeout(GUILD, "5", "r"),
    ]) {
      const error = await action().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UserError);
      expect((error as Error).message).toBe(BOT_MISSING_PERMISSIONS);
    }
  });

  test("a member who left in the meantime, or an unknown user, is explained", async () => {
    const guild = createModerationGuild(
      guildClient({ banError: discordError(RESTJSONErrorCodes.UnknownUser) }).client,
    );
    await expect(guild.kick(GUILD, "5", "r")).rejects.toThrow(MEMBER_GONE);
    await expect(guild.ban(GUILD, "5", "r")).rejects.toThrow(UNKNOWN_USER);
  });

  test("other failures stay errors to log", async () => {
    const guild = createModerationGuild(guildClient({ banError: discordError(500) }).client);
    const error = await guild.ban(GUILD, "5", "r").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(UserError);
  });
});

describe("purge", () => {
  function channelClient(
    ids: string[],
    channelExtra: Record<string, unknown> = {},
    pinnedIds: string[] = [],
  ) {
    const fetches: unknown[] = [];
    const bulk: { ids: string[]; filterOld: boolean }[] = [];
    // Shuffled on purpose: the adapter must not trust the order of the collection.
    const messages = new Map(
      [...ids].reverse().map((id) => [id, { id, pinned: pinnedIds.includes(id) }]),
    );
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      messages: {
        fetch: async (options: unknown) => {
          fetches.push(options);
          return messages;
        },
      },
      bulkDelete: async (deleting: string[], filterOld: boolean) => {
        bulk.push({ ids: deleting, filterOld });
        return new Map(deleting.map((id) => [id, { id }]));
      },
      ...channelExtra,
    };
    const client = { channels: { fetch: async () => channel } } as unknown as Client;
    return { guild: createModerationGuild(client, () => NOW), fetches, bulk };
  }

  /** Newest first, like Discord returns them. */
  const recent = Array.from({ length: 6 }, (_, i) => idAged((i + 1) * 60_000));

  test("deletes the newest `count` messages", async () => {
    const { guild, fetches, bulk } = channelClient(recent);
    expect(await guild.purge(CHANNEL, 3, 0)).toEqual({ deleted: 3, tooOld: 0, pinned: 0 });
    expect(fetches).toEqual([{ limit: 3 }]);
    expect(bulk).toEqual([{ ids: recent.slice(0, 3), filterOld: true }]);
  });

  test("skipNewest leaves the newest messages and still deletes `count`", async () => {
    const { guild, fetches, bulk } = channelClient(recent);
    await guild.purge(CHANNEL, 3, 1);
    expect(fetches).toEqual([{ limit: 4 }]);
    expect(bulk[0]?.ids).toEqual(recent.slice(1, 4));
  });

  test("never asks Discord for more than 100 messages", async () => {
    const { guild, fetches } = channelClient(recent);
    await guild.purge(CHANNEL, 100, 1);
    expect(fetches).toEqual([{ limit: 100 }]);
  });

  test("messages at the 14 day limit are left and counted", async () => {
    const fresh = idAged(14 * DAY - 2 * 60_000);
    const edge = idAged(14 * DAY - 30_000);
    const old = idAged(20 * DAY);
    const { guild, bulk } = channelClient([fresh, edge, old]);
    expect(await guild.purge(CHANNEL, 3, 0)).toEqual({ deleted: 1, tooOld: 2, pinned: 0 });
    expect(bulk[0]?.ids).toEqual([fresh]);
  });

  test("pinned messages are left and counted, old pinned ones as pinned", async () => {
    const oldPinned = idAged(20 * DAY);
    const ids = [...recent.slice(0, 3), oldPinned];
    const { guild, bulk } = channelClient(ids, {}, [recent[1] ?? "", oldPinned]);
    expect(await guild.purge(CHANNEL, 4, 0)).toEqual({ deleted: 2, tooOld: 0, pinned: 2 });
    expect(bulk[0]?.ids).toEqual([recent[0] ?? "", recent[2] ?? ""]);
  });

  test("nothing deletable means no bulk delete at all", async () => {
    const { guild, bulk } = channelClient([idAged(30 * DAY)]);
    expect(await guild.purge(CHANNEL, 5, 0)).toEqual({ deleted: 0, tooOld: 1, pinned: 0 });
    expect(bulk).toEqual([]);
  });

  test("a single message goes through bulk delete too", async () => {
    const { guild, bulk } = channelClient(recent);
    expect(await guild.purge(CHANNEL, 1, 0)).toEqual({ deleted: 1, tooOld: 0, pinned: 0 });
    expect(bulk).toEqual([{ ids: [recent[0] ?? ""], filterOld: true }]);
  });

  test("the deleted count is what Discord reports", async () => {
    const { guild } = channelClient(recent, {
      bulkDelete: async (deleting: string[]) => new Map(deleting.slice(1).map((id) => [id, {}])),
    });
    expect(await guild.purge(CHANNEL, 3, 0)).toEqual({ deleted: 2, tooOld: 0, pinned: 0 });
  });

  test("Missing Permissions or Missing Access on the purge becomes a UserError", async () => {
    for (const code of [RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.MissingAccess]) {
      const { guild } = channelClient(recent, {
        bulkDelete: async () => {
          throw discordError(code);
        },
      });
      await expect(guild.purge(CHANNEL, 2, 0)).rejects.toThrow(BOT_MISSING_PERMISSIONS);
    }
  });

  test("a DM or a channel without text is refused", async () => {
    for (const extra of [{ isDMBased: () => true }, { isTextBased: () => false }]) {
      const { guild } = channelClient(recent, extra);
      await expect(guild.purge(CHANNEL, 2, 0)).rejects.toThrow(NOT_A_TEXT_CHANNEL);
    }
  });
});

describe("direct messages", () => {
  function dmClient(sendError?: unknown) {
    const sent: unknown[] = [];
    const user = {
      send: async (payload: unknown) => {
        if (sendError) throw sendError;
        sent.push(payload);
      },
    };
    const client = { users: { fetch: async () => user } } as unknown as Client;
    return { guild: createModerationGuild(client), sent };
  }

  test("sends the text without pinging anyone", async () => {
    const { guild, sent } = dmClient();
    expect(await guild.sendDirect("5", "@everyone hej")).toBe(true);
    expect(sent).toEqual([{ content: "@everyone hej", allowedMentions: NO_MENTIONS }]);
  });

  test("closed DMs answer false, other failures are thrown", async () => {
    const closed = dmClient(discordError(RESTJSONErrorCodes.CannotSendMessagesToThisUser));
    expect(await closed.guild.sendDirect("5", "x")).toBe(false);
    await expect(dmClient(discordError(500)).guild.sendDirect("5", "x")).rejects.toThrow();
  });
});
