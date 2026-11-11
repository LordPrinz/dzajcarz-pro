import { describe, expect, test } from "bun:test";
import { type Logger, silentLogger } from "@dzajcarz/core";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
  MessageFlags,
} from "discord.js";
import { contextFromInteraction, contextFromMessage, placeOf, slashArgs } from "./context.ts";
import { NO_MENTIONS } from "./reply.ts";

function fakeInteraction(data: unknown[], subcommand: string | null, deferReply = async () => {}) {
  return {
    deferReply,
    deferred: false,
    replied: false,
    options: { data, getSubcommand: () => subcommand },
    user: { id: "1", displayName: "tester" },
    guildId: null,
    channelId: "2",
    inGuild: () => false,
  } as unknown as ChatInputCommandInteraction;
}

describe("slash interactions", () => {
  test("a plain command reads its options from the top level", () => {
    const interaction = fakeInteraction(
      [{ name: "text", type: ApplicationCommandOptionType.String, value: "hej" }],
      null,
    );
    expect(slashArgs(interaction)).toEqual({ text: "hej" });
    expect(contextFromInteraction(interaction).subcommand).toBeUndefined();
  });

  test("a subcommand's arguments come from the nested options, and its name reaches the context", () => {
    const interaction = fakeInteraction(
      [
        {
          name: "set",
          type: ApplicationCommandOptionType.Subcommand,
          options: [{ name: "value", type: ApplicationCommandOptionType.String, value: "?" }],
        },
      ],
      "set",
    );
    expect(slashArgs(interaction)).toEqual({ value: "?" });
    expect(contextFromInteraction(interaction).subcommand).toBe("set");
  });

  test("a subcommand without options has no arguments", () => {
    const interaction = fakeInteraction(
      [{ name: "show", type: ApplicationCommandOptionType.Subcommand }],
      "show",
    );
    expect(slashArgs(interaction)).toEqual({});
  });

  test("defer passes the ephemeral flag to Discord only when asked", async () => {
    const calls: unknown[] = [];
    const interaction = fakeInteraction([], null, async (options?: unknown) => {
      calls.push(options);
    });
    await contextFromInteraction(interaction).defer({ ephemeral: true });
    await contextFromInteraction(interaction).defer();
    expect(calls).toEqual([{ flags: MessageFlags.Ephemeral }, { flags: undefined }]);
  });
});

describe("place", () => {
  test("follows the interaction context, so a group DM is not the DM with the bot", () => {
    expect(placeOf(InteractionContextType.Guild, "1")).toBe("guild");
    expect(placeOf(InteractionContextType.BotDM, null)).toBe("bot-dm");
    expect(placeOf(InteractionContextType.PrivateChannel, null)).toBe("private-channel");
  });

  test("without a context a guild id means a server and none a DM with the bot", () => {
    expect(placeOf(null, "1")).toBe("guild");
    expect(placeOf(undefined, null)).toBe("bot-dm");
  });

  test("slash and prefix contexts carry it", () => {
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, { context: InteractionContextType.PrivateChannel });
    expect(contextFromInteraction(interaction).place).toBe("private-channel");
    expect(contextFromInteraction(interaction).messageId).toBeUndefined();
    const message = (guildId: string | null) =>
      ({
        id: "77",
        guildId,
        channelId: "2",
        author: { id: "1", displayName: "t" },
        member: null,
        channel: { isDMBased: () => guildId === null },
      }) as unknown as Message;
    expect(contextFromMessage(message("5"), {}).messageId).toBe("77");
    expect(contextFromMessage(message("5"), {}).place).toBe("guild");
    expect(contextFromMessage(message(null), {}).place).toBe("bot-dm");
  });
});

describe("reactions", () => {
  const EMOJI = ["🙋‍♂️", "👍"];

  /** `failing`: every react call throws, as when the bot lacks Add Reactions. */
  function fakeMessage(failing = false) {
    const reacted: string[] = [];
    let attempts = 0;
    const message = {
      react: async (emoji: string) => {
        attempts++;
        if (failing) throw new Error("Missing Permissions");
        reacted.push(emoji);
      },
    };
    return { message, reacted, attempts: () => attempts };
  }

  /** A prefix context whose `message.reply` records its payload and returns `sent`. */
  function prefixContext(sent: unknown, payloads: unknown[] = [], logger?: Logger) {
    return contextFromMessage(
      {
        guildId: "5",
        channelId: "2",
        author: { id: "1", displayName: "t" },
        member: null,
        channel: { isDMBased: () => false },
        reply: async (options: unknown) => {
          payloads.push(options);
          return sent;
        },
      } as unknown as Message,
      {},
      undefined,
      logger,
    );
  }

  /** A logger that records its warn calls. */
  function warnRecorder() {
    const calls: { message: string; fields?: Record<string, unknown> }[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (message, fields) => {
        calls.push({ message, fields });
      },
    };
    return { logger, calls };
  }

  test("slash: asks for the response message and reacts to it", async () => {
    const { message, reacted } = fakeMessage();
    const calls: unknown[] = [];
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, {
      reply: async (options: unknown) => {
        calls.push(options);
        return { resource: { message } };
      },
    });
    await contextFromInteraction(interaction).reply({ content: "ok", reactions: EMOJI });
    expect(reacted).toEqual(EMOJI);
    expect(calls[0]).toMatchObject({ content: "ok", withResponse: true });
  });

  test("slash: a reply without reactions does not ask for the response", async () => {
    const calls: unknown[] = [];
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, {
      reply: async (options: unknown) => {
        calls.push(options);
      },
    });
    await contextFromInteraction(interaction).reply("ok");
    expect(calls[0]).not.toHaveProperty("withResponse");
  });

  test("slash: an ephemeral reply after a public defer follows up privately and deletes the placeholder", async () => {
    const calls: string[] = [];
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, {
      deferred: true,
      ephemeral: false,
      deleteReply: async () => {
        calls.push("delete");
      },
      followUp: async (options: { flags?: unknown }) => {
        calls.push(`followUp:${String(options.flags)}`);
      },
      editReply: async () => {
        calls.push("edit");
      },
    });
    await contextFromInteraction(interaction).reply({ content: "błąd", ephemeral: true });
    expect(calls).toEqual([`followUp:${MessageFlags.Ephemeral}`, "delete"]);
  });

  test("slash: a public reply after a public defer, or any reply after an ephemeral defer, edits it", async () => {
    const calls: string[] = [];
    for (const [ephemeral, deferEphemeral] of [
      [false, false],
      [true, true],
    ] as const) {
      const interaction = fakeInteraction([], null);
      Object.assign(interaction, {
        deferred: true,
        ephemeral: deferEphemeral,
        deleteReply: async () => {
          calls.push("delete");
        },
        editReply: async () => {
          calls.push("edit");
        },
      });
      await contextFromInteraction(interaction).reply({ content: "ok", ephemeral });
    }
    expect(calls).toEqual(["edit", "edit"]);
  });

  test("slash: a failing delete or follow-up is logged and does not throw", async () => {
    for (const failing of ["deleteReply", "followUp"]) {
      const followUps: unknown[] = [];
      const interaction = fakeInteraction([], null);
      Object.assign(interaction, {
        deferred: true,
        ephemeral: false,
        deleteReply: async () => {
          if (failing === "deleteReply") throw new Error("gone");
        },
        followUp: async (options: unknown) => {
          if (failing === "followUp") throw new Error("expired");
          followUps.push(options);
        },
      });
      const warnings = warnRecorder();
      await contextFromInteraction(interaction, warnings.logger).reply({
        content: "błąd",
        ephemeral: true,
      });
      expect(warnings.calls).toHaveLength(1);
      // A failed delete must not lose the private message.
      expect(followUps).toHaveLength(failing === "deleteReply" ? 1 : 0);
    }
  });

  test("slash: reacts to the edited reply of a deferred interaction", async () => {
    const { message, reacted } = fakeMessage();
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, { deferred: true, editReply: async () => message });
    await contextFromInteraction(interaction).reply({ content: "ok", reactions: EMOJI });
    expect(reacted).toEqual(EMOJI);
  });

  test("slash: reacts to the follow-up of an interaction that already replied", async () => {
    const { message, reacted } = fakeMessage();
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, { replied: true, followUp: async () => message });
    await contextFromInteraction(interaction).reply({ content: "ok", reactions: EMOJI });
    expect(reacted).toEqual(EMOJI);
  });

  test("slash: a failing reaction is swallowed and the reply still went out", async () => {
    const fake = fakeMessage(true);
    const calls: unknown[] = [];
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, {
      reply: async (options: unknown) => {
        calls.push(options);
        return { resource: { message: fake.message } };
      },
    });
    const warnings = warnRecorder();
    await contextFromInteraction(interaction, warnings.logger).reply({
      content: "ok",
      reactions: EMOJI,
    });
    expect(calls[0]).toMatchObject({ content: "ok" });
    expect(fake.attempts()).toBe(1);
    expect(warnings.calls).toHaveLength(1);
    expect(warnings.calls[0]?.fields).toMatchObject({ emoji: EMOJI[0] });
  });

  test("slash: no response message to react to is fine", async () => {
    const interaction = fakeInteraction([], null);
    const calls: unknown[] = [];
    Object.assign(interaction, {
      reply: async (options: unknown) => {
        calls.push(options);
        return { resource: null };
      },
    });
    await expect(
      contextFromInteraction(interaction).reply({ content: "ok", reactions: EMOJI }),
    ).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ content: "ok" });
  });

  test("prefix: reacts to the sent reply", async () => {
    const { message, reacted } = fakeMessage();
    await prefixContext(message).reply({ content: "ok", reactions: EMOJI });
    expect(reacted).toEqual(EMOJI);
  });

  test("prefix: a failing reaction is swallowed and the reply still went out", async () => {
    const fake = fakeMessage(true);
    const payloads: unknown[] = [];
    const warnings = warnRecorder();
    await prefixContext(fake.message, payloads, warnings.logger).reply({
      content: "ok",
      reactions: EMOJI,
    });
    expect(payloads[0]).toMatchObject({ content: "ok" });
    expect(fake.attempts()).toBe(1);
    expect(warnings.calls).toHaveLength(1);
    expect(warnings.calls[0]?.fields).toMatchObject({ emoji: EMOJI[0] });
  });
});

describe("prefix replies", () => {
  test("pass NO_MENTIONS and still go out when the command message is gone", async () => {
    const sent: unknown[] = [];
    const message = {
      guildId: "5",
      channelId: "2",
      author: { id: "1", displayName: "t" },
      member: null,
      channel: { isDMBased: () => false },
      reply: async (payload: unknown) => void sent.push(payload),
    } as unknown as Message;
    await contextFromMessage(message, {}).reply("hej");
    expect(sent).toEqual([
      {
        content: "hej",
        embeds: [],
        components: [],
        allowedMentions: NO_MENTIONS,
        failIfNotExists: false,
      },
    ]);
  });
});
