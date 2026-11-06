import { type BotModule, defineCommand, defineSubcommand, UserError } from "@dzajcarz/core";

/** Where a guild's custom prefix lives. `forget`-style cache invalidation is the implementation's job. */
export interface PrefixSettings {
  /** The guild's own prefix, or null when it uses the default. */
  get(guildId: string): Promise<string | null>;
  set(guildId: string, prefix: string): Promise<void>;
  /** Back to the default prefix. */
  reset(guildId: string): Promise<void>;
}

export interface SettingsModuleDeps {
  prefixes: PrefixSettings;
  defaultPrefix: string;
}

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

export function createSettingsModule({ prefixes, defaultPrefix }: SettingsModuleDeps): BotModule {
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

  return { name: "settings", commands: [prefix] };
}
