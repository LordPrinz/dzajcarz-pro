import { type BotModule, defineCommand, defineSubcommand, UserError } from "@dzajcarz/core";

/** Where a guild's custom prefix lives. `forget`-style cache invalidation is the implementation's job. */
export interface PrefixSettings {
  /** The guild's own prefix, or null when it uses the default. */
  get(guildId: string): Promise<string | null>;
  set(guildId: string, prefix: string): Promise<void>;
  /** Back to the default prefix. */
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

export interface SettingsModuleDeps {
  prefixes: PrefixSettings;
  defaultPrefix: string;
  modules: ModuleToggles;
}

/** Modules that stay on: without them nobody could turn anything back on or ask for help. */
export const PROTECTED_MODULES: ReadonlySet<string> = new Set(["general", "settings"]);

/** PermissionFlagsBits.ManageGuild; modules do not import discord.js at runtime. */
const MANAGE_GUILD = 1n << 5n;

const MAX_PREFIX_LENGTH = 5;

/** Throws a UserError (Polish) unless the prefix is 1-5 characters of non-whitespace, non-backtick text. */
export function validatePrefix(prefix: string): void {
  if (prefix.length < 1 || prefix.length > MAX_PREFIX_LENGTH) {
    throw new UserError(`Prefiks musi mieć od 1 do ${MAX_PREFIX_LENGTH} znaków.`);
  }
  if (/\s/u.test(prefix)) throw new UserError("Prefiks nie może zawierać spacji.");
  // The prefix is echoed inside code spans, where a backtick would close the span.
  if (prefix.includes("`")) throw new UserError("Prefiks nie może zawierać znaku `.");
}

export function createSettingsModule({
  prefixes,
  defaultPrefix,
  modules,
}: SettingsModuleDeps): BotModule {
  // Guild-only is implied by `permissions`, so guildId is set when these run.
  const guildOf = (guildId: string | null): string => {
    if (guildId === null) throw new UserError("Ta komenda działa tylko na serwerze.");
    return guildId;
  };

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
          await prefixes.set(guildOf(ctx.guildId), ctx.args.prefix);
          await ctx.reply({ content: `Prefiks to teraz \`${ctx.args.prefix}\`.`, ephemeral: true });
        },
      }),
      reset: defineSubcommand({
        description: "Przywraca domyślny prefiks",
        run: async (ctx) => {
          await prefixes.reset(guildOf(ctx.guildId));
          await ctx.reply({
            content: `Przywrócono domyślny prefiks \`${defaultPrefix}\`.`,
            ephemeral: true,
          });
        },
      }),
      show: defineSubcommand({
        description: "Pokazuje aktualny prefiks",
        run: async (ctx) => {
          const current = (await prefixes.get(guildOf(ctx.guildId))) ?? defaultPrefix;
          await ctx.reply({
            content: `Prefiks na tym serwerze to \`${current}\`. Możesz też wspomnieć bota.`,
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
      throw new UserError(
        `Nie ma modułu \`${name}\`. Dostępne moduły: ${valid.map((n) => `\`${n}\``).join(", ") || "brak"}.`,
      );
    }
    if (PROTECTED_MODULES.has(module)) {
      throw new UserError(`Modułu \`${module}\` nie można wyłączyć.`);
    }
    return module;
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
          const disabled = await modules.list(guildOf(ctx.guildId));
          const lines = modules.moduleNames().map((name) => {
            const entries = disabled.filter((d) => d.module === name);
            if (entries.length === 0) return `\`${name}\`: włączony`;
            if (entries.some((d) => d.channelId === null))
              return `\`${name}\`: wyłączony na serwerze`;
            const channels = entries.map((d) => `<#${d.channelId}>`).join(", ");
            return `\`${name}\`: wyłączony na kanałach ${channels}`;
          });
          await ctx.reply({ content: lines.join("\n"), ephemeral: true });
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
          await modules.disable(guildOf(ctx.guildId), module, channelId);
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
          const changed = await modules.enable(guildOf(ctx.guildId), module, channelId);
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

  return { name: "settings", commands: [prefix, modulesCommand] };
}
