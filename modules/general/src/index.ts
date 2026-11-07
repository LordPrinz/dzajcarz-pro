import {
  type BotModule,
  type CommandContexts,
  type CommandSummary,
  defineCommand,
  type Embed,
} from "@dzajcarz/core";
import { COMMAND_NOT_FOUND, createHelp, type HelpDeps, syntax } from "./help.ts";

export interface GeneralModuleDeps extends HelpDeps {
  /** Gateway heartbeat in ms; -1 before the first heartbeat. */
  gatewayPing: () => number;
}

const BRAND_COLOR = 0xf5a623;

/** Everywhere: servers, a DM with the bot and other private channels, for both install types. */
const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

export function createGeneralModule(deps: GeneralModuleDeps): BotModule {
  const ping = defineCommand({
    name: "ping",
    description: "Sprawdza, czy bot żyje, i pokazuje opóźnienie",
    contexts: EVERYWHERE,
    run: async (ctx) => {
      const ms = deps.gatewayPing();
      await ctx.reply(ms < 0 ? "Pong!" : `Pong! ${Math.round(ms)} ms`);
    },
  });

  const helpMenu = createHelp(deps);

  const help = defineCommand({
    name: "help",
    description: "Lista komend albo opis jednej z nich",
    aliases: ["pomoc"],
    contexts: EVERYWHERE,
    options: {
      command: { type: "string", description: "Nazwa komendy" },
    },
    run: async (ctx) => {
      // Backticks would close the code span around the echoed name and let it inject markdown.
      const wanted = ctx.args.command?.toLowerCase().replaceAll("`", "");
      if (!wanted) {
        await ctx.reply({ ...(await helpMenu.startPage(ctx)), ephemeral: true });
        return;
      }
      const { command, prefix } = await helpMenu.find(ctx, wanted);
      await ctx.reply(
        command
          ? { embeds: [describeCommand(command, prefix)] }
          : { content: COMMAND_NOT_FOUND(wanted), ephemeral: true },
      );
    },
  });

  return { name: "general", commands: [ping, help], components: helpMenu.components };
}

export function describeCommand(command: CommandSummary, prefix: string | null): Embed {
  const aliases = prefix === null ? "" : command.aliases.map((a) => `\`${prefix}${a}\``).join(", ");
  return {
    title: `/${command.name}`,
    description: command.description,
    color: BRAND_COLOR,
    fields: [
      command.subcommands.length > 0
        ? {
            name: "Podkomendy",
            value: command.subcommands
              .map((s) => `${syntax(s.usage, prefix)} ${s.description}`)
              .join("\n"),
          }
        : { name: "Użycie", value: syntax(command.usage, prefix) },
      ...(aliases ? [{ name: "Aliasy", value: aliases }] : []),
    ],
  };
}
