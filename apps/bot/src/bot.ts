import {
  type AnyCommand,
  type CommandRegistry,
  type ComponentKind,
  type CooldownStore,
  checkPrefixAccess,
  executeCommand,
  executeComponent,
  executeModal,
  type Logger,
  matchPrefix,
  type PrefixInvocation,
  parsePrefixArgs,
  type RegisteredEvent,
  splitInvocation,
  UNKNOWN_COMPONENT,
  UNKNOWN_MODAL,
} from "@dzajcarz/core";
import {
  type Client,
  Events,
  type Message,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import { contextFromComponent } from "./discord/component-context.ts";
import { contextFromInteraction, contextFromMessage } from "./discord/context.ts";
import { contextFromModal } from "./discord/modal-context.ts";
import { readModalValues } from "./discord/modals.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import { eventScope, toggleChannelId } from "./event-scope.ts";
import type { ModuleGate } from "./module-gate.ts";
import type { PrefixResolver } from "./prefix-resolver.ts";

export interface BotDeps {
  registry: CommandRegistry;
  prefixes: PrefixResolver;
  gate: ModuleGate;
  /** Whether the bot is a member of the guild; false for a server reached through a user install. */
  botInGuild: (guildId: string) => boolean;
  /** Counts command calls for `cooldownMs`; without it cooldowns are not enforced. */
  cooldowns?: CooldownStore;
  logger: Logger;
}

const MODULE_DISABLED_REPLY = "Ten moduł jest wyłączony na tym serwerze albo kanale.";

/**
 * Whether `module` is on where it was used. A guild the bot is not in (user install) has no toggle rows,
 * so the gate (and its Redis and database reads) is skipped there.
 */
async function moduleOn(
  { gate, botInGuild }: Pick<BotDeps, "gate" | "botInGuild">,
  module: string,
  guildId: string | null,
  channelId: string,
): Promise<boolean> {
  if (guildId !== null && !botInGuild(guildId)) return true;
  return gate.isEnabled(guildId, channelId, module);
}

/** Whether the module that owns `command` is on where the command was used. */
async function commandEnabled(
  deps: Pick<BotDeps, "registry" | "gate" | "botInGuild">,
  command: AnyCommand,
  guildId: string | null,
  channelId: string,
): Promise<boolean> {
  const module = deps.registry.moduleOf(command);
  return module === undefined || (await moduleOn(deps, module, guildId, channelId));
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
    let guildId: string | undefined;
    try {
      const scope = eventScope(handler.event, args);
      guildId = scope?.guildId;
      if (
        scope &&
        !handler.alwaysRun &&
        !(await gate.isEnabled(scope.guildId, scope.channelId, module))
      )
        return;
      await handler.run(...args);
    } catch (error) {
      logger.error("Event handler failed", {
        handler: handler.name,
        event: handler.event,
        module,
        guildId,
        error,
      });
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
      if (interaction.isMessageComponent()) {
        await handleComponent(interaction, deps);
        return;
      }
      if (interaction.isModalSubmit()) {
        await handleModal(interaction, deps);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const command = registry.find(interaction.commandName);
      if (!command) {
        // Registered on Discord but not in this build: deploy commands again after removing one.
        logger.warn("Unknown slash command", { command: interaction.commandName });
        return;
      }
      const ctx = contextFromInteraction(interaction, logger);
      const toggleChannel = toggleChannelId(interaction.channel, ctx.channelId);
      if (!(await commandEnabled(deps, command, ctx.guildId, toggleChannel))) {
        await ctx.reply({ content: MODULE_DISABLED_REPLY, ephemeral: true });
        return;
      }
      await executeCommand(command, ctx, logger, deps.cooldowns);
    } catch (error) {
      logger.error("Interaction handling failed", {
        interactionId: interaction.id,
        guildId: interaction.guildId,
        command: "commandName" in interaction ? interaction.commandName : undefined,
        customId: "customId" in interaction ? interaction.customId : undefined,
        error,
      });
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message, client.user?.id, deps);
    } catch (error) {
      logger.error("Message handling failed", {
        messageId: message.id,
        guildId: message.guildId,
        error,
      });
    }
  });
}

function componentKind(interaction: MessageComponentInteraction): ComponentKind | undefined {
  if (interaction.isButton()) return "button";
  if (interaction.isStringSelectMenu()) return "select";
  if (interaction.isUserSelectMenu()) return "user-select";
  return undefined;
}

/**
 * A click on a button or select menu: found by custom_id, gated by its module's toggles like a command,
 * then run through the owner and permission checks of `executeComponent`.
 */
export async function handleComponent(
  interaction: MessageComponentInteraction,
  deps: BotDeps,
): Promise<void> {
  const { registry, logger } = deps;
  const supported =
    interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu();
  const found = supported ? registry.resolveComponent(interaction.customId) : undefined;
  // A handler written for a button must not receive a select's values, whatever custom_id arrives.
  const resolved = found?.component.kind === componentKind(interaction) ? found : undefined;
  if (!supported || !resolved) {
    // Posted by an older build or by another bot sharing the application, or a select type no module
    // handles yet (role, channel, mentionable): answer instead of leaving the click to time out.
    logger.warn("Unknown component", { customId: interaction.customId });
    await interaction.reply({
      content: UNKNOWN_COMPONENT,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  const ctx = contextFromComponent(interaction, resolved);
  const toggleChannel = toggleChannelId(interaction.channel, ctx.channelId);
  if (!(await moduleOn(deps, resolved.module, ctx.guildId, toggleChannel))) {
    await ctx.reply({ content: MODULE_DISABLED_REPLY, ephemeral: true });
    return;
  }
  await executeComponent(resolved, ctx, logger);
}

/**
 * A submitted modal: found by custom_id, gated by its module's toggles like a command or a click, then run
 * through the owner and permission checks and the field validation of `executeModal`.
 */
export async function handleModal(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
): Promise<void> {
  const { registry, logger } = deps;
  const resolved = registry.resolveModal(interaction.customId);
  if (!resolved) {
    logger.warn("Unknown modal", { customId: interaction.customId });
    await interaction.reply({
      content: UNKNOWN_MODAL,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  const ctx = contextFromModal(interaction, resolved.state);
  const toggleChannel = toggleChannelId(interaction.channel, ctx.channelId);
  if (!(await moduleOn(deps, resolved.module, ctx.guildId, toggleChannel))) {
    await ctx.reply({ content: MODULE_DISABLED_REPLY, ephemeral: true });
    return;
  }
  await executeModal(resolved, ctx, readModalValues(resolved.modal, interaction), logger);
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
  const context = contextFromMessage(message, {}, undefined, logger);
  const denied = checkPrefixAccess(command, invocation.rest, context);
  if (denied) {
    await message.reply(prefixAnswer(denied));
    return;
  }

  const parsed = parsePrefixArgs(command, invocation.rest);
  if (!parsed.ok) {
    await message.reply(prefixAnswer(parsed.error));
    return;
  }
  await executeCommand(
    command,
    contextFromMessage(message, parsed.args, parsed.subcommand, logger),
    logger,
    deps.cooldowns,
  );
}

/** A plain message still answers when the command message was deleted before the reply went out. */
function prefixAnswer(content: string) {
  return { content, allowedMentions: NO_MENTIONS, failIfNotExists: false };
}

/** A text command starts with the guild prefix or with a mention of the bot (`@Dżajcarz ping`). */
export function matchInvocation(
  content: string,
  prefix: string,
  botUserId: string | undefined,
): PrefixInvocation | null {
  // The mention goes first: with a guild prefix of `<` or `<@`, `<@BOT> ping` would otherwise parse as a
  // prefix command named `@BOT>`.
  const mention = botUserId
    ? [`<@${botUserId}>`, `<@!${botUserId}>`].find((m) => content.startsWith(m))
    : undefined;
  if (mention) return splitInvocation(content.slice(mention.length).trimStart());
  return matchPrefix(content, prefix);
}
