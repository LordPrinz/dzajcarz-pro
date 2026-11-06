import { type BotModule, type CommandSummary, defineCommand, type Embed } from "@dzajcarz/core";

export interface GeneralModuleDeps {
  /** Every registered command; read when /help runs, so it includes modules registered later. */
  commands: () => readonly CommandSummary[];
  /** Gateway heartbeat in ms; -1 before the first heartbeat. */
  gatewayPing: () => number;
  /** The prefix for this guild, shown in /help. */
  prefixFor: (guildId: string | null) => Promise<string>;
}

const BRAND_COLOR = 0xf5a623;

export function createGeneralModule(deps: GeneralModuleDeps): BotModule {
  const ping = defineCommand({
    name: "ping",
    description: "Sprawdza, czy bot żyje, i pokazuje opóźnienie",
    run: async (ctx) => {
      const ms = deps.gatewayPing();
      await ctx.reply(ms < 0 ? "Pong!" : `Pong! ${Math.round(ms)} ms`);
    },
  });

  const help = defineCommand({
    name: "help",
    description: "Lista komend albo opis jednej z nich",
    aliases: ["pomoc"],
    options: {
      command: { type: "string", description: "Nazwa komendy" },
    },
    run: async (ctx) => {
      const prefix = await deps.prefixFor(ctx.guildId);
      const all = deps.commands();
      // Backticks would close the code span around the echoed name and let it inject markdown.
      const wanted = ctx.args.command?.toLowerCase().replaceAll("`", "");
      if (wanted) {
        const found = all.find((c) => c.name === wanted || c.aliases.includes(wanted));
        await ctx.reply(
          found
            ? { embeds: [describeCommand(found, prefix)] }
            : { content: `Nie znam komendy \`${wanted}\`.`, ephemeral: true },
        );
        return;
      }
      await ctx.reply({ embeds: [listCommands(all, prefix)], ephemeral: true });
    },
  });

  return { name: "general", commands: [ping, help] };
}

export function listCommands(commands: readonly CommandSummary[], prefix: string): Embed {
  const byModule = Map.groupBy(commands, (c) => c.module);
  return {
    title: "Komendy Dżajcarza",
    description: `Każda komenda działa jako \`/nazwa\` albo \`${prefix}nazwa\`.`,
    color: BRAND_COLOR,
    fields: [...byModule].map(([module, list]) => ({
      name: module,
      value: list.map((c) => `\`${c.name}\` ${c.description}`).join("\n"),
    })),
  };
}

export function describeCommand(command: CommandSummary, prefix: string): Embed {
  const aliases = command.aliases.map((a) => `\`${prefix}${a}\``).join(", ");
  return {
    title: `/${command.name}`,
    description: command.description,
    color: BRAND_COLOR,
    fields: [
      ...(command.subcommands.length > 0
        ? [
            {
              name: "Podkomendy",
              value: command.subcommands
                .map((s) => `\`${prefix}${s.usage}\` ${s.description}`)
                .join("\n"),
            },
          ]
        : []),
      ...(aliases ? [{ name: "Aliasy", value: aliases }] : []),
    ],
  };
}
