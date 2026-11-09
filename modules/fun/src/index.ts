import { type BotModule, type CommandContexts, defineCommand } from "@dzajcarz/core";

export interface FunModuleDeps {
  /** Uniform in [0, 1), like `Math.random`. */
  random: () => number;
  now: () => Date;
  /** IANA zone `/time` reports in. */
  timeZone: string;
}

const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

export function createFunModule(deps: FunModuleDeps): BotModule {
  // h23 keeps midnight at 00; a 12/24 hybrid cycle can print 24.
  const clock = new Intl.DateTimeFormat("pl-PL", {
    timeZone: deps.timeZone,
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
    run: async (ctx) => {
      if (deps.random() < 0.5) await ctx.reply({ content: "Wiedział!", reactions: ["🙋‍♂️"] });
      else await ctx.reply("Nie wiedział sadge bruh");
    },
  });

  const time = defineCommand({
    name: "time",
    description: "Aktualny czas w Polsce",
    contexts: EVERYWHERE,
    run: async (ctx) => {
      await ctx.reply(`Jest ${clock.format(deps.now())}.`);
    },
  });

  return { name: "fun", commands: [didYouKnow, time] };
}
