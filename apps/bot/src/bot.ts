import {
  type CommandRegistry,
  checkAccess,
  executeCommand,
  type Logger,
  matchPrefix,
  type PrefixInvocation,
  parsePrefixArgs,
  splitInvocation,
} from "@dzajcarz/core";
import { type Client, Events, type Message } from "discord.js";
import { contextFromInteraction, contextFromMessage } from "./discord/context.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import type { PrefixResolver } from "./prefix-resolver.ts";

export interface BotDeps {
  registry: CommandRegistry;
  prefixes: PrefixResolver;
  logger: Logger;
}

/** Routes Discord events to module handlers and commands. */
export function attachHandlers(client: Client, { registry, prefixes, logger }: BotDeps): void {
  for (const { handler } of registry.events()) {
    const listener = async (...args: unknown[]) => {
      try {
        await handler.run(...args);
      } catch (error) {
        logger.error("Event handler failed", {
          handler: handler.name,
          event: handler.event,
          error,
        });
      }
    };
    if (handler.once) client.once(handler.event, listener);
    else client.on(handler.event, listener);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = registry.find(interaction.commandName);
    if (!command) {
      // Registered on Discord but not in this build: deploy commands again after removing one.
      logger.warn("Unknown slash command", { command: interaction.commandName });
      return;
    }
    await executeCommand(command, contextFromInteraction(interaction), logger);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message, client.user?.id, { registry, prefixes, logger });
    } catch (error) {
      logger.error("Message handling failed", { messageId: message.id, error });
    }
  });
}

async function handleMessage(
  message: Message,
  botUserId: string | undefined,
  { registry, prefixes, logger }: BotDeps,
): Promise<void> {
  if (message.author.bot || message.webhookId) return;
  const invocation = matchInvocation(
    message.content,
    await prefixes.resolve(message.guildId),
    botUserId,
  );
  if (!invocation) return;
  // Another bot may share the prefix, so unknown names stay silent.
  const command = registry.find(invocation.name);
  if (!command) return;

  // Checked before parsing so a member without access never learns the usage of a command they cannot run.
  const context = contextFromMessage(message, {});
  const denied = checkAccess(command, context);
  if (denied) {
    await message.reply({ content: denied, allowedMentions: NO_MENTIONS });
    return;
  }

  const parsed = parsePrefixArgs(command, invocation.rest);
  if (!parsed.ok) {
    await message.reply({ content: parsed.error, allowedMentions: NO_MENTIONS });
    return;
  }
  await executeCommand(
    command,
    contextFromMessage(message, parsed.args, parsed.subcommand),
    logger,
  );
}

/** A text command starts with the guild prefix or with a mention of the bot (`@Dżajcarz ping`). */
export function matchInvocation(
  content: string,
  prefix: string,
  botUserId: string | undefined,
): PrefixInvocation | null {
  const byPrefix = matchPrefix(content, prefix);
  if (byPrefix) return byPrefix;
  if (!botUserId) return null;
  const mention = [`<@${botUserId}>`, `<@!${botUserId}>`].find((m) => content.startsWith(m));
  if (!mention) return null;
  return splitInvocation(content.slice(mention.length).trimStart());
}
