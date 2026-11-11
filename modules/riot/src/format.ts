import { type Embed, escapeMarkdown } from "@dzajcarz/core";
import type { LolProfile, LolQueueEntry, ValorantMatch, ValorantProfile } from "./ports.ts";

const VALORANT_COLOR = 0xff4655;
const LOL_COLOR = 0xc89b3c;

/** Discord: a field value holds at most 1024 characters. */
const FIELD_LIMIT = 1024;

const POINTS = new Intl.NumberFormat("pl-PL");

/** Player and champion names come from Riot, so markdown in them must not format the embed. */
export function escapeText(text: string): string {
  return escapeMarkdown(text).replace(/\s+/g, " ");
}

const riotIdTitle = ({ gameName, tagLine }: { gameName: string; tagLine: string }) =>
  `${escapeText(gameName)}#${escapeText(tagLine)}`;

const QUEUE_LABELS: Record<string, string> = {
  competitive: "Rankingowa",
  unrated: "Nierankingowa",
  swiftplay: "Swiftplay",
  spikerush: "Spike Rush",
  deathmatch: "Deathmatch",
  ggteam: "Eskalacja",
  hurm: "Team Deathmatch",
};

/** A Polish name for the common queues, the raw id for the rest, nothing for an empty one. */
const queueLabel = (queue: string) =>
  queue === "" ? "" : (QUEUE_LABELS[queue] ?? escapeText(queue));

function matchLine(match: ValorantMatch): string {
  const outcome = match.won === null ? "Mecz" : match.won ? "Wygrana" : "Porażka";
  const result = match.score === null ? outcome : `${outcome} ${match.score}`;
  const when = `<t:${Math.floor(match.startedAt.getTime() / 1000)}:R>`;
  return [
    result,
    escapeText(match.map),
    escapeText(match.agent),
    `${match.kills}/${match.deaths}/${match.assists}`,
    queueLabel(match.queue),
    when,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export function valorantEmbed(profile: ValorantProfile): Embed {
  // Whole lines only, so a long map or agent name never cuts a line in the middle of a timestamp.
  const kept: string[] = [];
  let length = 0;
  for (const line of profile.matches.map(matchLine)) {
    length += line.length + (kept.length > 0 ? 1 : 0);
    if (length > FIELD_LIMIT) break;
    kept.push(line);
  }
  const matches = kept.length === 0 ? "Brak ostatnich meczów." : kept.join("\n");
  return {
    title: riotIdTitle(profile.riotId),
    color: VALORANT_COLOR,
    fields: [
      { name: "Region", value: escapeText(profile.region.toUpperCase()), inline: true },
      {
        name: "Ranga",
        value: profile.rank ? escapeText(profile.rank) : "Bez rangi",
        inline: true,
      },
      { name: "Ostatnie mecze", value: matches },
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
  { queue: "solo", name: "Solo/Duo" },
  { queue: "flex", name: "Flex" },
] as const;

export function lolEmbed(profile: LolProfile): Embed {
  const queueFields = QUEUES.map(({ queue, name }) => {
    const entry = profile.queues.find((candidate) => candidate.queue === queue);
    return {
      name,
      value: entry
        ? `${tierLabel(entry)}, ${entry.lp} LP (${entry.wins}W/${entry.losses}L)`
        : "Bez rangi",
      inline: true,
    };
  });
  const champions = profile.topChampions
    .map(
      (champion) =>
        `**${escapeText(champion.name)}**, poziom ${champion.level}, ${POINTS.format(champion.points)} pkt`,
    )
    .join("\n");
  return {
    title: riotIdTitle(profile.riotId),
    // Empty when Data Dragon could not tell the current version.
    thumbnail: profile.iconUrl || undefined,
    color: LOL_COLOR,
    fields: [
      { name: "Poziom", value: String(profile.level), inline: true },
      ...queueFields,
      { name: "Najlepsi bohaterowie", value: champions || "Brak danych o mistrzostwie." },
    ],
  };
}
