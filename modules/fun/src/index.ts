import {
  type BotModule,
  type CommandContexts,
  defineCommand,
  type GuildTimeZones,
  type Locale,
} from "@dzajcarz/core";
import { t } from "./messages.ts";

export interface FunModuleDeps {
  /** Uniform in [0, 1), like `Math.random`. */
  random: () => number;
  now: () => Date;
  /** `/time` reports the server's clock; in DMs and private channels the default zone. */
  timeZones: GuildTimeZones;
}

const INTL_LOCALES: Record<Locale, string> = { pl: "pl-PL", en: "en-GB", de: "de-DE" };

const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

export function createFunModule(deps: FunModuleDeps): BotModule {
  // h23 keeps midnight at 00; a 12/24 hybrid cycle can print 24.
  const clockIn = (timeZone: string, locale: Locale) =>
    new Intl.DateTimeFormat(INTL_LOCALES[locale], {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

  const didYouKnow = defineCommand({
    name: "czy_wiedziałeś",
    description: t.all("didYouKnowDescription"),
    aliases: ["czy_wiedziales", "czywiedzial"],
    contexts: EVERYWHERE,
    cooldownMs: 3_000,
    run: async (ctx) => {
      const text = t(ctx.locale);
      if (deps.random() < 0.5) await ctx.reply({ content: text.knew, reactions: ["🙋‍♂️"] });
      else await ctx.reply(text.didNotKnow);
    },
  });

  const time = defineCommand({
    name: "time",
    description: t.all("timeDescription"),
    contexts: EVERYWHERE,
    run: async (ctx) => {
      const zone = await deps.timeZones.of(ctx.guildId);
      await ctx.reply(t(ctx.locale).timeNow(clockIn(zone, ctx.locale).format(deps.now())));
    },
  });

  return { name: "fun", commands: [didYouKnow, time] };
}
