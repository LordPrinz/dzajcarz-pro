import {
  type BotModule,
  defineCommand,
  defineEvent,
  defineSubcommand,
  type Logger,
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

/** Asks Discord about channels, so a channel id typed by a member is never trusted on its own. */
export interface TextChannels {
  /** Whether the channel is a text or announcement channel of this guild. */
  isTextChannelOf(guildId: string, channelId: string): Promise<boolean>;
}

/** Name and size of a guild, for `/welcome test`. */
export interface GuildLookup {
  describe(guildId: string): Promise<{ name: string; memberCount: number } | null>;
}

export interface WelcomeModuleDeps {
  store: WelcomeConfigStore;
  sender: WelcomeSender;
  guilds: GuildLookup;
  channels: TextChannels;
  logger: Logger;
}

/** PermissionFlagsBits.ManageGuild; modules do not import discord.js at runtime. */
const MANAGE_GUILD = 1n << 5n;

export function createWelcomeModule({
  store,
  sender,
  guilds,
  channels,
  logger,
}: WelcomeModuleDeps): BotModule {
  const guildOf = (guildId: string | null): string => {
    if (guildId === null) throw new UserError("Ta komenda działa tylko na serwerze.");
    return guildId;
  };

  const welcome = defineCommand({
    name: "welcome",
    description: "Wiadomość powitalna dla nowych członków serwera",
    permissions: MANAGE_GUILD,
    subcommands: {
      set: defineSubcommand({
        description: "Ustawia kanał i treść powitania",
        options: {
          channel: { type: "channel", description: "Kanał z powitaniami", required: true },
          message: {
            type: "string",
            description: "Treść: {user}, {username}, {server}, {memberCount}",
            required: true,
            rest: true,
          },
        },
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
          const template = ctx.args.message.trim();
          if (template.length === 0) throw new UserError("Treść powitania nie może być pusta.");
          if ([...template].length > MAX_MESSAGE_LENGTH) {
            throw new UserError(`Powitanie może mieć najwyżej ${MAX_MESSAGE_LENGTH} znaków.`);
          }
          if (!(await channels.isTextChannelOf(guildId, ctx.args.channel))) {
            throw new UserError("Wybierz kanał tekstowy z tego serwera.");
          }
          await store.set(guildId, { channelId: ctx.args.channel, template });
          await ctx.reply({
            content: `Nowi członkowie będą witani na <#${ctx.args.channel}>. Sprawdź wygląd przez \`welcome test\`.`,
            ephemeral: true,
          });
        },
      }),
      off: defineSubcommand({
        description: "Wyłącza powitania",
        run: async (ctx) => {
          const removed = await store.delete(guildOf(ctx.guildId));
          await ctx.reply({
            content: removed ? "Powitania wyłączone." : "Powitania nie były ustawione.",
            ephemeral: true,
          });
        },
      }),
      test: defineSubcommand({
        description: "Wysyła powitanie dla Ciebie na skonfigurowany kanał",
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
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

  return { name: "welcome", commands: [welcome], events: [greet] };
}
