import { type Embed, escapeMarkdown, type Locale } from "@dzajcarz/core";
import { t } from "./messages.ts";
import type { LolProfile, LolQueueEntry, ValorantMatch, ValorantProfile } from "./ports.ts";

const VALORANT_COLOR = 0xff4655;
const LOL_COLOR = 0xc89b3c;

/** Discord: a field value holds at most 1024 characters. */
const FIELD_LIMIT = 1024;

const NUMBER_LOCALES: Record<Locale, string> = { pl: "pl-PL", en: "en-US", de: "de-DE" };

/** Player and champion names come from Riot, so markdown in them must not format the embed. */
export function escapeText(text: string): string {
  return escapeMarkdown(text).replace(/\s+/g, " ");
}

const riotIdTitle = ({ gameName, tagLine }: { gameName: string; tagLine: string }) =>
  `${escapeText(gameName)}#${escapeText(tagLine)}`;

const QUEUE_KEYS = {
  competitive: "queueCompetitive",
  unrated: "queueUnrated",
  swiftplay: "queueSwiftplay",
  spikerush: "queueSpikeRush",
  deathmatch: "queueDeathmatch",
  ggteam: "queueEscalation",
  hurm: "queueTeamDeathmatch",
} as const;

/** A translated name for the common queues, the raw id for the rest, nothing for an empty one. */
function queueLabel(queue: string, locale: Locale): string {
  if (queue === "") return "";
  const key = QUEUE_KEYS[queue as keyof typeof QUEUE_KEYS];
  return key ? t(locale)[key] : escapeText(queue);
}

function matchLine(match: ValorantMatch, locale: Locale): string {
  const text = t(locale);
  const outcome = match.won === null ? text.match : match.won ? text.won : text.lost;
  const result = match.score === null ? outcome : `${outcome} ${match.score}`;
  const when = `<t:${Math.floor(match.startedAt.getTime() / 1000)}:R>`;
  return [
    result,
    match.map === null ? text.unknownMap : escapeText(match.map),
    match.agent === null ? text.unknownAgent : escapeText(match.agent),
    `${match.kills}/${match.deaths}/${match.assists}`,
    queueLabel(match.queue, locale),
    when,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export function valorantEmbed(profile: ValorantProfile, locale: Locale): Embed {
  const text = t(locale);
  // Whole lines only, so a long map or agent name never cuts a line in the middle of a timestamp.
  const kept: string[] = [];
  let length = 0;
  for (const line of profile.matches.map((match) => matchLine(match, locale))) {
    length += line.length + (kept.length > 0 ? 1 : 0);
    if (length > FIELD_LIMIT) break;
    kept.push(line);
  }
  const matches = kept.length === 0 ? text.noMatches : kept.join("\n");
  return {
    title: riotIdTitle(profile.riotId),
    color: VALORANT_COLOR,
    fields: [
      { name: text.region, value: escapeText(profile.region.toUpperCase()), inline: true },
      {
        name: text.rank,
        value: profile.rank ? escapeText(profile.rank) : text.noRank,
        inline: true,
      },
      { name: text.recentMatches, value: matches },
    ],
  };
}

/** `GOLD` + `IV` becomes `Gold IV`; master and above have no division worth showing. */
function tierLabel({ tier, rank }: Pick<LolQueueEntry, "tier" | "rank">): string {
  const name = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
  const apex = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(tier.toUpperCase());
  return apex ? name : `${name} ${rank}`;
}

const QUEUES = [
  { queue: "solo", name: "queueSolo" },
  { queue: "flex", name: "queueFlex" },
] as const;

export function lolEmbed(profile: LolProfile, locale: Locale): Embed {
  const text = t(locale);
  const points = new Intl.NumberFormat(NUMBER_LOCALES[locale]);
  const queueFields = QUEUES.map(({ queue, name }) => {
    const entry = profile.queues.find((candidate) => candidate.queue === queue);
    return {
      name: text[name],
      value: entry
        ? text.leagueEntry(tierLabel(entry), entry.lp, entry.wins, entry.losses)
        : text.noRank,
      inline: true,
    };
  });
  const champions = profile.topChampions
    .map((champion) =>
      text.champion(escapeText(champion.name), champion.level, points.format(champion.points)),
    )
    .join("\n");
  return {
    title: riotIdTitle(profile.riotId),
    // Empty when Data Dragon could not tell the current version.
    thumbnail: profile.iconUrl || undefined,
    color: LOL_COLOR,
    fields: [
      { name: text.level, value: String(profile.level), inline: true },
      ...queueFields,
      { name: text.topChampions, value: champions || text.noMastery },
    ],
  };
}
