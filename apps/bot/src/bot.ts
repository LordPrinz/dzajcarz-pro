import {
  type AnyCommand,
  type CommandRegistry,
  checkPrefixAccess,
  executeCommand,
  executeComponent,
  type Logger,
  matchPrefix,
  type PrefixInvocation,
  parsePrefixArgs,
  type RegisteredEvent,
  splitInvocation,
  UNKNOWN_COMPONENT,
} from "@dzajcarz/core";
import {
  type ButtonInteraction,
  type Client,
  Events,
  type Message,
  MessageFlags,
  type StringSelectMenuInteraction,
} from "discord.js";
import { contextFromComponent } from "./discord/components.ts";
import { contextFromInteraction, contextFromMessage } from "./discord/context.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import { eventScope, toggleChannelId } from "./event-scope.ts";
import type { ModuleGate } from "./module-gate.ts";
import type { PrefixResolver } from "./prefix-resolver.ts";

export interface BotDeps {
  registry: CommandRegistry;
  prefixes: PrefixResolver;
  gate: ModuleGate;
  logger: Logger;
}

const MODULE_DISABLED_REPLY = "Ten moduł jest wyłączony na tym serwerze albo kanale.";

/** Whether the module that owns `command` is on where the command was used. */
async function commandEnabled(
  { registry, gate }: Pick<BotDeps, "registry" | "gate">,
  command: AnyCommand,
  guildId: string | null,
  channelId: string,
): Promise<boolean> {
  const module = registry.moduleOf(command);
  return module === undefined || (await gate.isEnabled(guildId, channelId, module));
}

/**
 * Wraps a module's event handler: it is skipped when its module is off for the event's guild and
 * channel (unless the handler is `alwaysRun`), and a failing handler is logged instead of crashing the process.
 */
export function createEventListener(
  { module, handler }: RegisteredEvent,
  gate: ModuleGate,
  logger: Logger,
): (...args: unknown[]) => Promise<void> {
  return async (...args) => {
    try {
      const scope = handler.alwaysRun ? undefined : eventScope(handler.event, args);
      if (scope && !(await gate.isEnabled(scope.guildId, scope.channelId, module))) return;
      await handler.run(...args);
    } catch (error) {
      logger.error("Event handler failed", { handler: handler.name, event: handler.event, error });
    }
  };
}

/** Routes Discord events to module handlers and commands. */
export function attachHandlers(client: Client, deps: BotDeps): void {
  const { registry, gate, logger } = deps;
  for (const entry of registry.events()) {
    const listener = createEventListener(entry, gate, logger);
    if (entry.handler.once) client.once(entry.handler.event, listener);
    else client.on(entry.handler.event, listener);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await handleComponent(interaction, deps);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const command = registry.find(interaction.commandName);
      if (!command) {
        // Registered on Discord but not in this build: deploy commands again after removing one.
        logger.warn("Unknown slash command", { command: interaction.commandName });
        return;
      }
      const ctx = contextFromInteraction(interaction);
      const toggleChannel = toggleChannelId(interaction.channel, ctx.channelId);
      if (!(await commandEnabled(deps, command, ctx.guildId, toggleChannel))) {
        await ctx.reply({ content: MODULE_DISABLED_REPLY, ephemeral: true });
        return;
      }
      await executeCommand(command, ctx, logger);
    } catch (error) {
      logger.error("Interaction handling failed", { interactionId: interaction.id, error });
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message, client.user?.id, deps);
    } catch (error) {
      logger.error("Message handling failed", { messageId: message.id, error });
    }
  });
}

/**
 * A click on a button or select menu: found by custom_id, gated by its module's toggles like a command,
 * then run through the owner and permission checks of `executeComponent`.
 */
export async function handleComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  { registry, gate, logger }: BotDeps,
): Promise<void> {
  const resolved = registry.resolveComponent(interaction.customId);
  if (!resolved) {
    // Posted by an older build or by another bot sharing the application: nothing to run.
    logger.warn("Unknown component", { customId: interaction.customId });
    await interaction.reply({ content: UNKNOWN_COMPONENT, flags: MessageFlags.Ephemeral });
    return;
  }
  const ctx = contextFromComponent(interaction, resolved);
  const toggleChannel = toggleChannelId(interaction.channel, ctx.channelId);
  if (!(await gate.isEnabled(ctx.guildId, toggleChannel, resolved.module))) {
    await ctx.reply({ content: MODULE_DISABLED_REPLY, ephemeral: true });
    return;
  }
  await executeComponent(resolved, ctx, logger);
}

export async function handleMessage(
  message: Message,
  botUserId: string | undefined,
  deps: BotDeps,
): Promise<void> {
  const { registry, prefixes, logger } = deps;
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
  // Silent like an unknown name: a reply to every attempt in a muted channel would be noise.
  if (
    !(await commandEnabled(
      deps,
      command,
      message.guildId,
      toggleChannelId(message.channel, message.channelId),
    ))
  )
    return;

  // Checked before parsing so a member without access never learns the usage of a command they cannot run.
  const context = contextFromMessage(message, {});
  const denied = checkPrefixAccess(command, invocation.rest, context);
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
