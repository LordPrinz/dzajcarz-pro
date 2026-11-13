import {
  type BotModule,
  type CommandContexts,
  type CommandSummary,
  defineCommand,
  type Embed,
  type Locale,
  localize,
} from "@dzajcarz/core";
import { BRAND_COLOR, createHelp, type HelpDeps, syntax } from "./help.ts";
import { t } from "./messages.ts";

export interface GeneralModuleDeps extends HelpDeps {
  /** Gateway heartbeat in ms; -1 before the first heartbeat. */
  gatewayPing: () => number;
}

/** Discord: an embed holds at most 25 fields. */
const MAX_EMBED_FIELDS = 25;
/** Discord's limit for a slash command name. */
const MAX_COMMAND_NAME = 32;

/** Everywhere: servers, a DM with the bot and other private channels, for both install types. */
const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

export function createGeneralModule(deps: GeneralModuleDeps): BotModule {
  const ping = defineCommand({
    name: "ping",
    description: t.all("pingDescription"),
    contexts: EVERYWHERE,
    run: async (ctx) => {
      const ms = deps.gatewayPing();
      const text = t(ctx.locale);
      await ctx.reply(ms < 0 ? text.pong : text.pongMs(Math.round(ms)));
    },
  });

  const helpMenu = createHelp(deps);

  const help = defineCommand({
    name: "help",
    description: t.all("helpDescription"),
    aliases: ["pomoc", "hilfe"],
    contexts: EVERYWHERE,
    options: {
      command: { type: "string", description: t.all("helpOption") },
    },
    run: async (ctx) => {
      // Backticks would close the code span around the echoed name and let it inject markdown. No command
      // name is longer than Discord's 32, and a longer one echoed back could push the reply past 2000.
      const typed = ctx.args.command?.toLowerCase().replaceAll("`", "");
      const wanted = typed && [...typed].slice(0, MAX_COMMAND_NAME).join("");
      if (!wanted) {
        await ctx.reply({ ...(await helpMenu.startPage(ctx, ctx.invocation)), ephemeral: true });
        return;
      }
      const { command, prefix } = await helpMenu.find(ctx, wanted);
      await ctx.reply(
        command
          ? { embeds: [describeCommand(command, prefix, ctx.locale)], ephemeral: true }
          : { content: t(ctx.locale).commandNotFound(wanted), ephemeral: true },
      );
    },
  });

  return { name: "general", commands: [ping, help], components: helpMenu.components };
}

export function describeCommand(
  command: CommandSummary,
  prefix: string | null,
  locale: Locale,
): Embed {
  const text = t(locale);
  const aliases = prefix === null ? "" : command.aliases.map((a) => `\`${prefix}${a}\``).join(", ");
  const aliasFields = aliases ? [{ name: text.aliases, value: aliases }] : [];
  // One field per subcommand: a single field holds 1024 characters, which a long command overflows.
  const body =
    command.subcommands.length > 0
      ? command.subcommands.slice(0, MAX_EMBED_FIELDS - aliasFields.length).map((s) => ({
          name: `${command.name} ${s.name}`,
          value: `${syntax({ slash: s.slashUsage, prefix: s.usage }, prefix)}\n${localize(s.description, locale)}`,
        }))
      : [
          {
            name: text.usage,
            value: syntax({ slash: command.slashUsage, prefix: command.usage }, prefix),
          },
        ];
  return {
    title: `/${command.name}`,
    description: localize(command.description, locale),
    color: BRAND_COLOR,
    fields: [...body, ...aliasFields],
  };
}
