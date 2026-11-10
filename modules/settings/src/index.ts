import {
  type BotModule,
  canonicalTimeZone,
  defineCommand,
  defineSubcommand,
  fitLines,
  MANAGE_GUILD,
  MAX_PREFIX_LENGTH,
  prefixProblem,
  requireGuild,
  UserError,
} from "@dzajcarz/core";

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

/** One place a module is switched off. */
export interface DisabledModule {
  module: string;
  /** null: the whole server. */
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
  /** For the clock shown next to a zone; the real time unless a test pins it. */
  now?: () => Date;
}

/** Modules that stay on: without them nobody could turn anything back on or ask for help. `status` has no per-server behaviour, so a toggle would do nothing. */
export const PROTECTED_MODULES: ReadonlySet<string> = new Set(["general", "settings", "status"]);

const MAX_ECHOED_NAME = 32;
/** The /modules list stays well under Discord's 2000; fitLines keeps room for its "… i jeszcze N" line. */
const MAX_LIST_LENGTH = 1900;
const MAX_CHANNELS_PER_LINE = 10;

const PREFIX_PROBLEMS = {
  length: `Prefiks musi mieć od 1 do ${MAX_PREFIX_LENGTH} znaków.`,
  whitespace: "Prefiks nie może zawierać spacji ani niewidocznych znaków.",
  backtick: "Prefiks nie może zawierać znaku `.",
} as const;

/** Throws a UserError (Polish) when the prefix breaks the core rule. */
function validatePrefix(prefix: string): void {
  const problem = prefixProblem(prefix);
  if (problem) throw new UserError(PREFIX_PROBLEMS[problem]);
}

export function createSettingsModule({
  prefixes,
  defaultPrefix,
  timeZones,
  defaultTimeZone,
  modules,
  channels,
  now = () => new Date(),
}: SettingsModuleDeps): BotModule {
  // These commands keep the default `contexts` (servers only), so guildId is set when they run; the check
  // below narrows the type and guards a future change of contexts.
  const prefix = defineCommand({
    name: "prefix",
    description: "Pokazuje albo zmienia prefiks komend na tym serwerze",
    permissions: MANAGE_GUILD,
    subcommands: {
      set: defineSubcommand({
        description: "Ustawia prefiks komend tekstowych",
        options: {
          prefix: { type: "string", description: "Nowy prefiks (1-5 znaków)", required: true },
        },
        run: async (ctx) => {
          validatePrefix(ctx.args.prefix);
          await prefixes.set(requireGuild(ctx.guildId), ctx.args.prefix);
          await ctx.reply({ content: `Prefiks to teraz \`${ctx.args.prefix}\`.`, ephemeral: true });
        },
      }),
      reset: defineSubcommand({
        description: "Przywraca domyślny prefiks",
        run: async (ctx) => {
          await prefixes.reset(requireGuild(ctx.guildId));
          await ctx.reply({
            content: `Przywrócono domyślny prefiks \`${defaultPrefix}\`.`,
            ephemeral: true,
          });
        },
      }),
      show: defineSubcommand({
        description: "Pokazuje aktualny prefiks",
        run: async (ctx) => {
          const current = (await prefixes.get(requireGuild(ctx.guildId))) ?? defaultPrefix;
          await ctx.reply({
            content: `Prefiks na tym serwerze to \`${current}\`. Możesz też wspomnieć bota.`,
            ephemeral: true,
          });
        },
      }),
    },
  });

  /** `Europe/Warsaw (teraz 14:05)`: the name and what its clock reads, so a wrong pick shows at once. */
  const describeZone = (zone: string) => {
    const clock = new Intl.DateTimeFormat("pl-PL", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now());
    return `\`${zone}\` (teraz ${clock})`;
  };

  const timezone = defineCommand({
    name: "timezone",
    description: "Strefa czasowa serwera: zaplanowane wiadomości i piosenki, /time, daty",
    permissions: MANAGE_GUILD,
    subcommands: {
      set: defineSubcommand({
        description: "Ustawia strefę czasową serwera",
        options: {
          zone: {
            type: "string",
            description: "Nazwa strefy IANA, np. Europe/Warsaw, Europe/London, America/New_York",
            required: true,
          },
        },
        run: async (ctx) => {
          const canonical = canonicalTimeZone(ctx.args.zone);
          const zone =
            canonical !== null && (await timeZones.isKnown(canonical)) ? canonical : null;
          if (zone === null) {
            const shown = [...ctx.args.zone.replaceAll("`", "")].slice(0, 64).join("");
            throw new UserError(
              `Nie znam strefy \`${shown}\`. Podaj nazwę IANA, np. \`Europe/Warsaw\`, \`Europe/London\` albo \`America/New_York\`.`,
            );
          }
          await timeZones.set(requireGuild(ctx.guildId), zone);
          await ctx.reply({
            content: `Strefa czasowa serwera to teraz ${describeZone(zone)}. Zaplanowane wiadomości i piosenki idą według niej.`,
            ephemeral: true,
          });
        },
      }),
      reset: defineSubcommand({
        description: "Przywraca domyślną strefę czasową",
        run: async (ctx) => {
          await timeZones.reset(requireGuild(ctx.guildId));
          await ctx.reply({
            content: `Przywrócono domyślną strefę ${describeZone(defaultTimeZone)}.`,
            ephemeral: true,
          });
        },
      }),
      show: defineSubcommand({
        description: "Pokazuje strefę czasową serwera",
        run: async (ctx) => {
          const own = await timeZones.get(requireGuild(ctx.guildId));
          await ctx.reply({
            content: `Strefa czasowa serwera: ${describeZone(own ?? defaultTimeZone)}${own === null ? " (domyślna)" : ""}.`,
            ephemeral: true,
          });
        },
      }),
    },
  });

  /** Throws a UserError (Polish) listing the valid names unless `name` is a module that can be toggled. */
  const toggleable = (name: string): string => {
    const module = name.toLowerCase();
    const known = modules.moduleNames();
    if (!known.includes(module)) {
      const valid = known.filter((n) => !PROTECTED_MODULES.has(n));
      // The name is echoed inside a code span: a backtick would close it, and length is capped for Discord's limit.
      const shown = [...name.replaceAll("`", "")].slice(0, MAX_ECHOED_NAME).join("");
      throw new UserError(
        `Nie ma modułu \`${shown}\`. Dostępne moduły: ${valid.map((n) => `\`${n}\``).join(", ") || "brak"}.`,
      );
    }
    if (PROTECTED_MODULES.has(module)) {
      throw new UserError(`Modułu \`${module}\` nie można wyłączyć.`);
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
      throw new UserError("Nie znalazłem takiego kanału na tym serwerze.");
    }
    if (await channels.isThread(guildId, channelId)) {
      throw new UserError(
        "Wątki dziedziczą ustawienia kanału nadrzędnego. Wybierz kanał, w którym wątek leży.",
      );
    }
  };

  const where = (channelId: string | null) =>
    channelId ? `na kanale <#${channelId}>` : "na serwerze";

  const modulesCommand = defineCommand({
    name: "modules",
    description: "Włącza i wyłącza moduły bota na serwerze albo na wybranym kanale",
    permissions: MANAGE_GUILD,
    subcommands: {
      list: defineSubcommand({
        description: "Pokazuje moduły i miejsca, w których są wyłączone",
        run: async (ctx) => {
          const disabled = await modules.list(requireGuild(ctx.guildId));
          const lines = modules.moduleNames().map((name) => {
            const entries = disabled.filter((d) => d.module === name);
            if (entries.length === 0) return `\`${name}\`: włączony`;
            if (entries.some((d) => d.channelId === null))
              return `\`${name}\`: wyłączony na serwerze`;
            const shown = entries.slice(0, MAX_CHANNELS_PER_LINE).map((d) => `<#${d.channelId}>`);
            const hidden = entries.length - shown.length;
            const more = hidden > 0 ? ` i jeszcze ${hidden}` : "";
            return `\`${name}\`: wyłączony na kanałach ${shown.join(", ")}${more}`;
          });
          await ctx.reply({ content: fitLines(lines, MAX_LIST_LENGTH), ephemeral: true });
        },
      }),
      disable: defineSubcommand({
        description: "Wyłącza moduł na serwerze albo na jednym kanale",
        options: {
          module: { type: "string", description: "Nazwa modułu", required: true },
          channel: { type: "channel", description: "Kanał (domyślnie cały serwer)" },
        },
        run: async (ctx) => {
          const module = toggleable(ctx.args.module);
          const channelId = ctx.args.channel ?? null;
          const guildId = requireGuild(ctx.guildId);
          await requireToggleableChannel(guildId, channelId);
          await modules.disable(guildId, module, channelId);
          await ctx.reply({
            content: `Moduł \`${module}\` jest wyłączony ${where(channelId)}.`,
            ephemeral: true,
          });
        },
      }),
      enable: defineSubcommand({
        description: "Włącza moduł z powrotem na serwerze albo na jednym kanale",
        options: {
          module: { type: "string", description: "Nazwa modułu", required: true },
          channel: { type: "channel", description: "Kanał (domyślnie cały serwer)" },
        },
        run: async (ctx) => {
          const module = toggleable(ctx.args.module);
          const channelId = ctx.args.channel ?? null;
          const guildId = requireGuild(ctx.guildId);
          const changed = await modules.enable(guildId, module, channelId);
          await ctx.reply({
            content: changed
              ? `Moduł \`${module}\` jest znów włączony ${where(channelId)}.`
              : `Moduł \`${module}\` nie był wyłączony ${where(channelId)}.`,
            ephemeral: true,
          });
        },
      }),
    },
  });

  return { name: "settings", commands: [prefix, timezone, modulesCommand] };
}
