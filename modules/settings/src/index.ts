import {
  type BotModule,
  canonicalTimeZone,
  DEFAULT_LOCALE,
  defineCommand,
  defineSubcommand,
  fitLines,
  hasPermissions,
  isLocale,
  LOCALE_NAMES,
  type Locale,
  MANAGE_GUILD,
  MAX_PREFIX_LENGTH,
  prefixProblem,
  requireGuild,
  UserError,
} from "@dzajcarz/core";
import { t } from "./messages.ts";

/** Where a guild's custom prefix lives. `forget`-style cache invalidation is the implementation's job. */
export interface PrefixSettings {
  /** The guild's own prefix, or null when it uses the default. */
  get(guildId: string): Promise<string | null>;
  set(guildId: string, prefix: string): Promise<void>;
  /** Back to the default prefix. */
  reset(guildId: string): Promise<void>;
}

/** Where a guild's time zone lives; cache refresh is the implementation's job. */
export interface TimeZoneSettings {
  /** The guild's own zone, or null when it uses the default. */
  get(guildId: string): Promise<string | null>;
  set(guildId: string, timeZone: string): Promise<void>;
  /** Whether the database can use the zone too; the runtime alone may know names it does not. */
  isKnown(timeZone: string): Promise<boolean>;
  /** Back to the default zone. */
  reset(guildId: string): Promise<void>;
}

/** Where the server's and the members' languages live; cache refresh is the implementation's job. */
export interface LanguageSettings {
  /** The server's own language, or null when it uses the default. */
  guild(guildId: string): Promise<Locale | null>;
  /** null goes back to the default. */
  setGuild(guildId: string, locale: Locale | null): Promise<void>;
  /** The member's own language for direct messages, or null when they never chose one. */
  user(userId: string): Promise<Locale | null>;
  /** null forgets the choice. */
  setUser(userId: string, locale: Locale | null): Promise<void>;
}

/** One place a module is switched off. */
export interface DisabledModule {
  module: string;
  /** A channel or category id; null: the whole server. */
  channelId: string | null;
}

/** Which modules a guild has switched off. Cache invalidation is the implementation's job. */
export interface ModuleToggles {
  /** Every module the bot runs. */
  moduleNames(): readonly string[];
  list(guildId: string): Promise<readonly DisabledModule[]>;
  disable(guildId: string, module: string, channelId: string | null): Promise<void>;
  /** False when that module was not disabled there. */
  enable(guildId: string, module: string, channelId: string | null): Promise<boolean>;
}

/** Asks Discord about channels, so a channel id typed by a member is never trusted on its own. */
export interface GuildChannels {
  /** Whether the channel exists and belongs to this guild. */
  belongsTo(guildId: string, channelId: string): Promise<boolean>;
  /** Whether the channel is a thread; toggles follow the parent channel, so threads cannot be switched. */
  isThread(guildId: string, channelId: string): Promise<boolean>;
}

export interface SettingsModuleDeps {
  prefixes: PrefixSettings;
  defaultPrefix: string;
  timeZones: TimeZoneSettings;
  /** The zone of servers that did not choose one. */
  defaultTimeZone: string;
  modules: ModuleToggles;
  channels: GuildChannels;
  languages: LanguageSettings;
  /** For the clock shown next to a zone; the real time unless a test pins it. */
  now?: () => Date;
}

/** Modules that stay on: without them nobody could turn anything back on or ask for help. `status` has no per-server behaviour, so a toggle would do nothing. */
export const PROTECTED_MODULES: ReadonlySet<string> = new Set(["general", "settings", "status"]);

const MAX_ECHOED_NAME = 32;
/** The /modules list stays well under Discord's 2000; fitLines keeps room for its "… i jeszcze N" line. */
const MAX_LIST_LENGTH = 1900;
const MAX_CHANNELS_PER_LINE = 10;

/** Throws a UserError when the prefix breaks the core rule. */
function validatePrefix(prefix: string): void {
  const problem = prefixProblem(prefix);
  if (problem === "length") throw new UserError((l) => t(l).prefixLength(MAX_PREFIX_LENGTH));
  if (problem === "whitespace") throw new UserError((l) => t(l).prefixWhitespace);
  if (problem === "backtick") throw new UserError((l) => t(l).prefixBacktick);
}

/** `/language` choices: each language under its own name, so everybody finds theirs, plus a reset. */
const RESET = "reset";
const LANGUAGE_CHOICES = [
  { name: LOCALE_NAMES.pl, value: "pl", aliases: ["polish", "polnisch"] },
  { name: LOCALE_NAMES.en, value: "en", aliases: ["angielski", "englisch"] },
  { name: LOCALE_NAMES.de, value: "de", aliases: ["niemiecki", "german"] },
  { name: t.all("languageDefault"), value: RESET, aliases: ["default", "domyslny"] },
] as const;

export function createSettingsModule({
  prefixes,
  defaultPrefix,
  timeZones,
  defaultTimeZone,
  modules,
  channels,
  languages,
  now = () => new Date(),
}: SettingsModuleDeps): BotModule {
  // These commands keep the default `contexts` (servers only), so guildId is set when they run; the check
  // below narrows the type and guards a future change of contexts.
  const prefix = defineCommand({
    name: "prefix",
    description: t.all("prefixDescription"),
    permissions: MANAGE_GUILD,
    subcommands: {
      set: defineSubcommand({
        description: t.all("prefixSetDescription"),
        options: {
          prefix: { type: "string", description: t.all("prefixOption"), required: true },
        },
        run: async (ctx) => {
          validatePrefix(ctx.args.prefix);
          await prefixes.set(requireGuild(ctx.guildId), ctx.args.prefix);
          await ctx.reply({ content: t(ctx.locale).prefixSet(ctx.args.prefix), ephemeral: true });
        },
      }),
      reset: defineSubcommand({
        description: t.all("prefixResetDescription"),
        run: async (ctx) => {
          await prefixes.reset(requireGuild(ctx.guildId));
          await ctx.reply({ content: t(ctx.locale).prefixReset(defaultPrefix), ephemeral: true });
        },
      }),
      show: defineSubcommand({
        description: t.all("prefixShowDescription"),
        run: async (ctx) => {
          const current = (await prefixes.get(requireGuild(ctx.guildId))) ?? defaultPrefix;
          await ctx.reply({ content: t(ctx.locale).prefixShow(current), ephemeral: true });
        },
      }),
    },
  });

  /** `Europe/Warsaw (teraz 14:05)`: the name and what its clock reads, so a wrong pick shows at once. */
  const describeZone = (zone: string, locale: Locale) => {
    const clock = new Intl.DateTimeFormat("pl-PL", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now());
    return t(locale).zone(zone, clock);
  };

  const timezone = defineCommand({
    name: "timezone",
    description: t.all("zoneDescription"),
    permissions: MANAGE_GUILD,
    subcommands: {
      set: defineSubcommand({
        description: t.all("zoneSetDescription"),
        options: {
          zone: { type: "string", description: t.all("zoneOption"), required: true },
        },
        run: async (ctx) => {
          const canonical = canonicalTimeZone(ctx.args.zone);
          const zone =
            canonical !== null && (await timeZones.isKnown(canonical)) ? canonical : null;
          if (zone === null) {
            const shown = [...ctx.args.zone.replaceAll("`", "")].slice(0, 64).join("");
            throw new UserError((l) => t(l).unknownZone(shown));
          }
          await timeZones.set(requireGuild(ctx.guildId), zone);
          await ctx.reply({
            content: t(ctx.locale).zoneSet(describeZone(zone, ctx.locale)),
            ephemeral: true,
          });
        },
      }),
      reset: defineSubcommand({
        description: t.all("zoneResetDescription"),
        run: async (ctx) => {
          await timeZones.reset(requireGuild(ctx.guildId));
          await ctx.reply({
            content: t(ctx.locale).zoneReset(describeZone(defaultTimeZone, ctx.locale)),
            ephemeral: true,
          });
        },
      }),
      show: defineSubcommand({
        description: t.all("zoneShowDescription"),
        run: async (ctx) => {
          const own = await timeZones.get(requireGuild(ctx.guildId));
          const zone = describeZone(own ?? defaultTimeZone, ctx.locale);
          await ctx.reply({ content: t(ctx.locale).zoneShow(zone, own === null), ephemeral: true });
        },
      }),
    },
  });

  /** Throws a UserError listing the valid names unless `name` is a module that can be toggled. */
  const toggleable = (name: string): string => {
    const module = name.toLowerCase();
    const known = modules.moduleNames();
    if (!known.includes(module)) {
      const valid = known.filter((n) => !PROTECTED_MODULES.has(n));
      // The name is echoed inside a code span: a backtick would close it, and length is capped for Discord's limit.
      const shown = [...name.replaceAll("`", "")].slice(0, MAX_ECHOED_NAME).join("");
      const list = valid.map((n) => `\`${n}\``).join(", ");
      throw new UserError((l) => t(l).unknownModule(shown, list));
    }
    if (PROTECTED_MODULES.has(module)) {
      throw new UserError((l) => t(l).protectedModule(module));
    }
    return module;
  };

  /**
   * The channel option is only an id, so check that it is a channel of this guild before storing it.
   * `enable` skips this: a row for a deleted channel must stay removable.
   */
  const requireToggleableChannel = async (guildId: string, channelId: string | null) => {
    if (channelId === null) return;
    if (!(await channels.belongsTo(guildId, channelId))) {
      throw new UserError((l) => t(l).channelNotFound);
    }
    if (await channels.isThread(guildId, channelId)) {
      throw new UserError((l) => t(l).threadChannel);
    }
  };

  const where = (channelId: string | null, locale: Locale) =>
    channelId ? t(locale).inChannel(channelId) : t(locale).onServer;

  const toggleOptions = {
    module: { type: "string", description: t.all("moduleOption"), required: true },
    channel: { type: "channel", description: t.all("channelOption") },
  } as const;

  const modulesCommand = defineCommand({
    name: "modules",
    description: t.all("modulesDescription"),
    permissions: MANAGE_GUILD,
    subcommands: {
      list: defineSubcommand({
        description: t.all("modulesListDescription"),
        run: async (ctx) => {
          const text = t(ctx.locale);
          const disabled = await modules.list(requireGuild(ctx.guildId));
          const lines = modules.moduleNames().map((name) => {
            const entries = disabled.filter((d) => d.module === name);
            if (entries.length === 0) return text.moduleOn(name);
            if (entries.some((d) => d.channelId === null)) return text.moduleOffServer(name);
            const shown = entries.slice(0, MAX_CHANNELS_PER_LINE).map((d) => `<#${d.channelId}>`);
            return text.moduleOffIn(name, shown.join(", "), entries.length - shown.length);
          });
          await ctx.reply({
            content: fitLines(lines, MAX_LIST_LENGTH, ctx.locale),
            ephemeral: true,
          });
        },
      }),
      disable: defineSubcommand({
        description: t.all("modulesDisableDescription"),
        options: toggleOptions,
        run: async (ctx) => {
          const module = toggleable(ctx.args.module);
          const channelId = ctx.args.channel ?? null;
          const guildId = requireGuild(ctx.guildId);
          await requireToggleableChannel(guildId, channelId);
          await modules.disable(guildId, module, channelId);
          const text = t(ctx.locale);
          // Scheduled DMs belong to no channel, so only a server-wide switch-off stops them.
          const dmNote = module === "messages" && channelId !== null ? text.dmNote : "";
          await ctx.reply({
            content: text.moduleDisabled(module, where(channelId, ctx.locale), dmNote),
            ephemeral: true,
          });
        },
      }),
      enable: defineSubcommand({
        description: t.all("modulesEnableDescription"),
        options: toggleOptions,
        run: async (ctx) => {
          const module = toggleable(ctx.args.module);
          const channelId = ctx.args.channel ?? null;
          const guildId = requireGuild(ctx.guildId);
          const changed = await modules.enable(guildId, module, channelId);
          const place = where(channelId, ctx.locale);
          await ctx.reply({
            content: changed
              ? t(ctx.locale).moduleEnabled(module, place)
              : t(ctx.locale).moduleNotDisabled(module, place),
            ephemeral: true,
          });
        },
      }),
    },
  });

  // On a server it is the server's language (Manage Server to change it); in the DM with the bot, the
  // member's own. Discord cannot gate only the change, so the permission check is ours.
  const language = defineCommand({
    name: "language",
    description: t.all("languageDescription"),
    aliases: ["jezyk", "sprache"],
    contexts: { places: ["guild", "bot-dm"], installs: ["guild"] },
    options: {
      language: { type: "string", description: t.all("languageOption"), choices: LANGUAGE_CHOICES },
    },
    run: async (ctx) => {
      const picked = ctx.args.language;
      const { guildId } = ctx;
      if (picked === undefined) {
        const own =
          guildId === null ? await languages.user(ctx.user.id) : await languages.guild(guildId);
        const name = LOCALE_NAMES[own ?? ctx.locale];
        const text = t(ctx.locale);
        await ctx.reply({
          content:
            guildId === null
              ? text.languageOfUser(name, own !== null)
              : text.languageOfGuild(name, own !== null),
          ephemeral: true,
        });
        return;
      }
      // The parser and Discord only let the choices through, so anything else is the reset.
      const chosen = isLocale(picked) ? picked : null;
      if (guildId === null) {
        await languages.setUser(ctx.user.id, chosen);
        // After a reset the client's language may apply, which only the adapter knows: stay in this one.
        const content = chosen ? t(chosen).languageSetUser : t(ctx.locale).languageResetUser;
        await ctx.reply({ content, ephemeral: true });
        return;
      }
      if (!hasPermissions(ctx.memberPermissions, MANAGE_GUILD)) {
        throw new UserError((l) => t(l).languageNeedsManageGuild);
      }
      await languages.setGuild(guildId, chosen);
      const content = chosen ? t(chosen).languageSetGuild : t(DEFAULT_LOCALE).languageResetGuild;
      await ctx.reply({ content, ephemeral: true });
    },
  });

  return { name: "settings", commands: [prefix, timezone, modulesCommand, language] };
}
