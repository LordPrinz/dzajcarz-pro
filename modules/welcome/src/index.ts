import {
  type BotModule,
  characterCount,
  codeBlocks,
  defineCommand,
  defineEvent,
  defineModal,
  defineSubcommand,
  type Logger,
  MANAGE_GUILD,
  requireGuild,
  type TextChannels,
  UserError,
} from "@dzajcarz/core";
import type { GuildMember } from "discord.js";
import { MAX_MESSAGE_LENGTH, renderWelcome } from "./template.ts";

export { MAX_MESSAGE_LENGTH, renderWelcome, type WelcomeValues } from "./template.ts";

export interface WelcomeConfig {
  channelId: string;
  template: string;
}

/** Where each guild's greeting is stored. */
export interface WelcomeConfigStore {
  get(guildId: string): Promise<WelcomeConfig | null>;
  set(guildId: string, config: WelcomeConfig): Promise<void>;
  /** False when the guild had no config. */
  delete(guildId: string): Promise<boolean>;
}

/**
 * Posts the greeting. Only `memberId` may be pinged: the greeting mentions the new member on purpose,
 * while anything else in the text (a server name, an admin's `@everyone`) must stay inert.
 * Rejects when the channel is missing, not text-based, or the bot may not write there.
 */
export interface WelcomeSender {
  /** `guildId` is the guild the greeting belongs to: a channel of any other guild must be refused. */
  send(guildId: string, channelId: string, text: string, memberId: string): Promise<void>;
}

export type { TextChannels } from "@dzajcarz/core";

/** Name and size of a guild, for `/welcome test`. */
export interface GuildLookup {
  describe(guildId: string): Promise<{ name: string; memberCount: number } | null>;
}

export interface WelcomeModuleDeps {
  store: WelcomeConfigStore;
  sender: WelcomeSender;
  guilds: GuildLookup;
  channels: TextChannels;
  /** The module toggle for a channel: the greeting is gated on the channel it is posted to. */
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
  logger: Logger;
}

export function createWelcomeModule({
  store,
  sender,
  guilds,
  channels,
  moduleEnabled,
  logger,
}: WelcomeModuleDeps): BotModule {
  const tooLong = `Powitanie może mieć najwyżej ${MAX_MESSAGE_LENGTH} znaków.`;

  /** Shared by the prefix form and the modal, so both refuse the same input. */
  async function saveWelcome(guildId: string, channelId: string, message: string): Promise<string> {
    const template = message.trim();
    if (template.length === 0) throw new UserError("Treść powitania nie może być pusta.");
    if (characterCount(template) > MAX_MESSAGE_LENGTH) {
      throw new UserError(tooLong);
    }
    if (!(await channels.isTextChannelOf(guildId, channelId))) {
      throw new UserError("Wybierz kanał tekstowy z tego serwera.");
    }
    await store.set(guildId, { channelId, template });
    return `Nowi członkowie będą witani na <#${channelId}>. Sprawdź wygląd przez \`welcome test\`.`;
  }

  const setForm = defineModal({
    module: "welcome",
    name: "set",
    title: "Powitanie nowych członków",
    permissions: MANAGE_GUILD,
    fields: {
      channel: {
        type: "channel",
        label: "Kanał",
        description: "Tu pojawi się powitanie.",
        channelTypes: ["text", "announcement"],
      },
      message: {
        type: "paragraph",
        label: "Treść powitania",
        description: `Zmienne: {user}, {username}, {server}, {memberCount}. Do ${MAX_MESSAGE_LENGTH} znaków.`,
        // Left optional so an empty answer gets the same wording as the prefix form.
        required: false,
        placeholder: "Witaj {user} na {server}! Jesteś {memberCount}. osobą.",
      },
    },
    run: async (ctx) => {
      const message = ctx.values.message ?? "";
      if (characterCount(message.trim()) > MAX_MESSAGE_LENGTH) {
        // The member typed all of it in a form that is now gone: hand the text back so it can be pasted again.
        await ctx.reply({ content: tooLong, ephemeral: true });
        for (const chunk of codeBlocks(message))
          await ctx.reply({ content: chunk, ephemeral: true });
        return;
      }
      const content = await saveWelcome(requireGuild(ctx.guildId), ctx.values.channel, message);
      await ctx.reply({ content, ephemeral: true });
    },
  });

  const welcome = defineCommand({
    name: "welcome",
    description: "Wiadomość powitalna dla nowych członków serwera",
    permissions: MANAGE_GUILD,
    subcommands: {
      set: defineSubcommand({
        description: "Ustawia kanał i treść powitania",
        options: {
          channel: {
            type: "channel",
            description: "Kanał z powitaniami",
            required: true,
            prefixOnly: true,
          },
          message: {
            type: "string",
            description: "Treść: {user}, {username}, {server}, {memberCount}",
            required: true,
            rest: true,
            prefixOnly: true,
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          if (ctx.canShowModal) {
            // showModal has to be the first answer, so only what is needed to prefill is looked up.
            const current = await store.get(guildId);
            // A channel that was deleted or turned into a voice channel would only be refused on submit.
            const channel =
              current && (await channels.isTextChannelOf(guildId, current.channelId))
                ? current.channelId
                : undefined;
            await ctx.showModal(
              setForm.build(
                ctx.user.id,
                undefined,
                current ? { channel, message: current.template } : undefined,
              ),
            );
            return;
          }
          const { channel, message } = ctx.args;
          if (channel === undefined || message === undefined) {
            throw new UserError("Podaj kanał i treść: `welcome set <channel> <message...>`.");
          }
          const content = await saveWelcome(guildId, channel, message);
          await ctx.reply({ content, ephemeral: true });
        },
      }),
      off: defineSubcommand({
        description: "Wyłącza powitania",
        run: async (ctx) => {
          const removed = await store.delete(requireGuild(ctx.guildId));
          await ctx.reply({
            content: removed ? "Powitania wyłączone." : "Powitania nie były ustawione.",
            ephemeral: true,
          });
        },
      }),
      test: defineSubcommand({
        description: "Wysyła powitanie dla Ciebie na skonfigurowany kanał",
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          // Fetching the guild and posting can take longer than the 3 s a slash command may stay silent.
          await ctx.defer({ ephemeral: true });
          const config = await store.get(guildId);
          if (!config) {
            throw new UserError("Powitania nie są ustawione. Użyj `welcome set`.");
          }
          const guild = await guilds.describe(guildId);
          if (!guild) throw new UserError("Nie mogę pobrać danych serwera.");
          const text = renderWelcome(config.template, {
            userId: ctx.user.id,
            username: ctx.user.displayName,
            serverName: guild.name,
            memberCount: guild.memberCount,
          });
          try {
            await sender.send(guildId, config.channelId, text, ctx.user.id);
          } catch (error) {
            logger.warn("Welcome test could not be sent", { guildId, error });
            throw new UserError(
              `Nie mogę wysłać wiadomości na <#${config.channelId}>. Sprawdź, czy kanał istnieje i czy bot może tam pisać.`,
            );
          }
          await ctx.reply({ content: "Wysłano powitanie testowe.", ephemeral: true });
        },
      }),
    },
  });

  const greet = defineEvent({
    name: "welcome-greet",
    event: "guildMemberAdd",
    run: (member: GuildMember) => greetMember(member),
  });

  /** Never throws: a broken config or a channel the bot cannot write to is a warning, not a crash. */
  async function greetMember(member: GuildMember): Promise<void> {
    // Bots (integrations, other bots) joining do not need a greeting; only people do.
    if (member.user.bot) return;
    const guildId = member.guild.id;
    try {
      const config = await store.get(guildId);
      if (!config) return;
      // The event is only gated guild-wide; a switch-off on the greeting channel is checked here.
      if (!(await moduleEnabled(guildId, config.channelId, "welcome"))) return;
      const text = renderWelcome(config.template, {
        userId: member.id,
        username: member.displayName,
        serverName: member.guild.name,
        memberCount: member.guild.memberCount,
      });
      await sender.send(guildId, config.channelId, text, member.id);
    } catch (error) {
      logger.warn("Welcome message not sent", { guildId, memberId: member.id, error });
    }
  }

  return { name: "welcome", commands: [welcome], events: [greet], modals: [setForm] };
}
