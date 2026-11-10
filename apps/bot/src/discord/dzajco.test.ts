import { describe, expect, test } from "bun:test";
import { type LogFields, type Logger, silentLogger } from "@dzajcarz/core";
import type { Client } from "discord.js";
import { createDzajcoResponder } from "./dzajco.ts";
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
    expect(t.replies).toEqual([{ content: GIF, allowedMentions: NO_MENTIONS }]);
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
