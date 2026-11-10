import { describe, expect, test } from "bun:test";
import { type LogFields, type Logger, silentLogger } from "@dzajcarz/core";
import type { Client } from "discord.js";
import { createDzajcoChannels, createDzajcoResponder } from "./dzajco.ts";
import { NO_MENTIONS } from "./reply.ts";

const GIF = "https://example.test/gif";

function setup({ reactFails = false, textBased = true } = {}) {
  const calls: string[] = [];
  const replies: unknown[] = [];
  const message = {
    react: async (emoji: string) => {
      calls.push(`react ${emoji}`);
      if (reactFails) throw new Error("Missing Permissions");
    },
    reply: async (payload: unknown) => {
      calls.push("reply");
      replies.push(payload);
    },
  };
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => textBased,
        messages: { fetch: async () => message },
      }),
    },
  } as unknown as Client;
  const warnings: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (text, fields) => void warnings.push({ message: text, fields }),
    child: () => logger,
  };
  return { responder: createDzajcoResponder(client, logger, GIF), calls, replies, warnings };
}

describe("Dzajco responder", () => {
  test("reacts with an egg, then replies with the gif and no mentions", async () => {
    const t = setup();
    await t.responder.respond("1", "2");
    expect(t.calls).toEqual(["react 🥚", "reply"]);
    expect(t.replies).toEqual([
      { content: GIF, allowedMentions: NO_MENTIONS, failIfNotExists: false },
    ]);
  });

  test("a failed reaction is logged and the gif still goes out", async () => {
    const t = setup({ reactFails: true });
    await t.responder.respond("1", "2");
    expect(t.calls).toEqual(["react 🥚", "reply"]);
    expect(t.warnings.map((w) => w.message)).toEqual(["Dżajco could not react"]);
  });

  test("a channel that is not text-based is an error", async () => {
    const t = setup({ textBased: false });
    await expect(t.responder.respond("1", "2")).rejects.toThrow("not text-based");
  });
});

describe("Dżajco channels", () => {
  const GUILD = "100000000000000001";
  function clientWith(channel: unknown) {
    return { channels: { fetch: async () => channel } } as unknown as Client;
  }
  const chat = (guildId: string, dm = false) => ({
    guildId,
    isTextBased: () => true,
    isDMBased: () => dm,
  });

  test("text channels, threads and voice chats of the guild count", async () => {
    expect(await createDzajcoChannels(clientWith(chat(GUILD))).isChatOf(GUILD, "1")).toBe(true);
  });

  test("another guild's chat, a DM, a category or a missing channel do not", async () => {
    const check = (channel: unknown) =>
      createDzajcoChannels(clientWith(channel)).isChatOf(GUILD, "1");
    expect(await check(chat("999"))).toBe(false);
    expect(await check(chat(GUILD, true))).toBe(false);
    expect(await check({ guildId: GUILD, isTextBased: () => false, isDMBased: () => false })).toBe(
      false,
    );
    expect(await check(null)).toBe(false);
    const failing = {
      channels: { fetch: async () => Promise.reject(new Error("Unknown Channel")) },
    } as unknown as Client;
    expect(await createDzajcoChannels(failing).isChatOf(GUILD, "1")).toBe(false);
  });
});
