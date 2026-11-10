import {
  type BotModule,
  type CommandContexts,
  defineCommand,
  type GuildTimeZones,
} from "@dzajcarz/core";

export interface FunModuleDeps {
  /** Uniform in [0, 1), like `Math.random`. */
  random: () => number;
  now: () => Date;
  /** `/time` reports the server's clock; in DMs and private channels the default zone. */
  timeZones: GuildTimeZones;
}

const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

export function createFunModule(deps: FunModuleDeps): BotModule {
  // h23 keeps midnight at 00; a 12/24 hybrid cycle can print 24.
  const clockIn = (timeZone: string) =>
    new Intl.DateTimeFormat("pl-PL", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

  const didYouKnow = defineCommand({
    name: "czy_wiedziałeś",
    description: "Odpowiada na odwieczne pytanie",
    aliases: ["czy_wiedziales", "czywiedzial"],
    contexts: EVERYWHERE,
    cooldownMs: 3_000,
    run: async (ctx) => {
      if (deps.random() < 0.5) await ctx.reply({ content: "Wiedział!", reactions: ["🙋‍♂️"] });
      else await ctx.reply("Nie wiedział sadge bruh");
    },
  });

  const time = defineCommand({
    name: "time",
    description: "Aktualny czas w strefie czasowej serwera",
    contexts: EVERYWHERE,
    run: async (ctx) => {
      const zone = await deps.timeZones.of(ctx.guildId);
      await ctx.reply(`Jest ${clockIn(zone).format(deps.now())}.`);
    },
  });

  return { name: "fun", commands: [didYouKnow, time] };
}
