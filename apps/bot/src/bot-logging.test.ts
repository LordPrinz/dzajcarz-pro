import { describe, expect, test } from "bun:test";
import { createRegistry, defineEvent, type Logger, silentLogger } from "@dzajcarz/core";
import type { Client } from "discord.js";
import { attachHandlers, createEventListener } from "./bot.ts";
import type { ModuleGate } from "./module-gate.ts";

const GUILD = "100000000000000001";
const gate: ModuleGate = { isEnabled: async () => true, forget: async () => {} };

function recordingLogger() {
  const errors: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const logger: Logger = {
    ...silentLogger,
    error: (message, fields) => void errors.push({ message, fields }),
    child: () => logger,
  };
  return { logger, errors };
}

function attach(logger: Logger) {
  const listeners = new Map<string, (...args: unknown[]) => Promise<void>>();
  const client = {
    on: (event: string, listener: (...args: unknown[]) => Promise<void>) =>
      void listeners.set(event, listener),
    once: () => {},
    user: { id: "111111111111111111" },
  } as unknown as Client;
  attachHandlers(client, {
    registry: createRegistry([{ name: "fun" }]),
    gate,
    prefixes: {
      resolve: async () => {
        throw new Error("redis down");
      },
      forget: async () => {},
    },
    botInGuild: () => true,
    logger,
  });
  return listeners;
}

describe("failure logs carry where they happened", () => {
  test("an alwaysRun event handler failure logs the guild and module", async () => {
    const { logger, errors } = recordingLogger();
    const boom = defineEvent({
      name: "boom",
      event: "messageCreate",
      alwaysRun: true,
      run: () => {
        throw new Error("nope");
      },
    });
    const [entry] = createRegistry([{ name: "fun", events: [boom] }]).events();
    if (!entry) throw new Error("event missing");
    const message = { guildId: GUILD, channelId: "3", channel: null };
    await createEventListener(entry, gate, logger)(message);
    expect(errors[0]?.fields).toMatchObject({ handler: "boom", module: "fun", guildId: GUILD });
  });

  test("a failed message handling logs the guild", async () => {
    const { logger, errors } = recordingLogger();
    const message = {
      id: "9",
      guildId: GUILD,
      author: { bot: false },
      webhookId: null,
      content: "!x",
    };
    await attach(logger).get("messageCreate")?.(message);
    expect(errors[0]).toMatchObject({
      message: "Message handling failed",
      fields: { messageId: "9", guildId: GUILD },
    });
  });

  test("a failed interaction logs the guild and the command or custom id", async () => {
    const { logger, errors } = recordingLogger();
    const listener = attach(logger).get("interactionCreate");
    const boom = () => {
      throw new Error("nope");
    };
    await listener?.({ id: "1", guildId: GUILD, commandName: "ping", isMessageComponent: boom });
    await listener?.({ id: "2", guildId: GUILD, customId: "menu:1", isMessageComponent: boom });
    expect(errors.map((entry) => entry.fields)).toMatchObject([
      { interactionId: "1", guildId: GUILD, command: "ping" },
      { interactionId: "2", guildId: GUILD, customId: "menu:1" },
    ]);
  });
});
