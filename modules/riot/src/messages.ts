import { defineMessages } from "@dzajcarz/core";

/**
 * Every member-facing text of the riot module. Names that come from Riot (players, maps, agents, champions,
 * ranks) are data and stay as the API returns them.
 */
export const t = defineMessages({
  pl: {
    valorantDescription: "Statystyki gracza Valorant: ranga i ostatnie mecze",
    lolDescription: "Statystyki gracza League of Legends: rangi i najlepsi bohaterowie",
    valorantIdOption: "Riot ID, np. Nazwa#TAG",
    lolIdOption:
      'Riot ID, np. Nazwa#TAG (z odstępami w cudzysłowie: !lol "Nazwa ze spacją#TAG" euw)',
    regionOption: "Serwer gry (domyślnie eune)",

    riotIdHelp: "Podaj Riot ID jako `Nazwa#TAG`.",
    statsOff: (game: string) => `Statystyki ${game} są wyłączone: bot nie ma klucza API.`,
    unknownRegion: "Nieznany serwer gry.",
    pause: (seconds: number) => `Riot API prosi o przerwę. Spróbuj za ${seconds} s.`,
    cooldown: "Poczekaj chwilę przed kolejnym sprawdzeniem.",
    tooManyLookups: "Za dużo zapytań do Riot w ostatniej minucie. Spróbuj za chwilę.",
    notFound: (player: string) => `Nie znalazłem gracza **${player}**.`,
    /** `region` is the chosen server's label ("EUNE"), undefined when unknown. */
    noRegionProfile: (player: string, region: string | undefined) =>
      `Gracz **${player}** nie ma konta League of Legends na serwerze ${region ?? "tym"}. Spróbuj z innym regionem.`,
    forbiddenValorant:
      "Klucz Riot API nie ma dostępu do tych danych (klucz deweloperski nie czyta historii meczów Valorant).",
    forbiddenLol: "Klucz Riot API wygasł albo nie ma dostępu.",
    unavailable: "Riot API nie odpowiada. Spróbuj za chwilę.",

    region: "Region",
    rank: "Ranga",
    noRank: "Bez rangi",
    recentMatches: "Ostatnie mecze",
    noMatches: "Brak ostatnich meczów.",
    match: "Mecz",
    unknownMap: "Nieznana mapa",
    unknownAgent: "Nieznany agent",
    won: "Wygrana",
    lost: "Porażka",
    queueCompetitive: "Rankingowa",
    queueUnrated: "Nierankingowa",
    queueSwiftplay: "Swiftplay",
    queueSpikeRush: "Spike Rush",
    queueDeathmatch: "Deathmatch",
    queueEscalation: "Eskalacja",
    queueTeamDeathmatch: "Team Deathmatch",

    level: "Poziom",
    queueSolo: "Solo/Duo",
    queueFlex: "Flex",
    leagueEntry: (tier: string, lp: number, wins: number, losses: number) =>
      `${tier}, ${lp} LP (${wins}W/${losses}L)`,
    champion: (name: string, level: number, points: string) =>
      `**${name}**, poziom ${level}, ${points} pkt`,
    topChampions: "Najlepsi bohaterowie",
    noMastery: "Brak danych o mistrzostwie.",
  },
  en: {
    valorantDescription: "Valorant player stats: rank and recent matches",
    lolDescription: "League of Legends player stats: ranks and top champions",
    valorantIdOption: "Riot ID, e.g. Name#TAG",
    lolIdOption: 'Riot ID, e.g. Name#TAG (with spaces, in quotes: !lol "Name with space#TAG" euw)',
    regionOption: "Game server (eune by default)",

    riotIdHelp: "Give the Riot ID as `Name#TAG`.",
    statsOff: (game) => `${game} stats are off: the bot has no API key.`,
    unknownRegion: "Unknown game server.",
    pause: (seconds) => `The Riot API asks for a break. Try again in ${seconds} s.`,
    cooldown: "Wait a moment before the next lookup.",
    tooManyLookups: "Too many requests to Riot in the last minute. Try again in a moment.",
    notFound: (player) => `I couldn't find the player **${player}**.`,
    noRegionProfile: (player, region) =>
      `The player **${player}** has no League of Legends account on ${region === undefined ? "this server" : `the ${region} server`}. Try another region.`,
    forbiddenValorant:
      "The Riot API key has no access to this data (a development key can't read Valorant match history).",
    forbiddenLol: "The Riot API key has expired or has no access.",
    unavailable: "The Riot API is not responding. Try again in a moment.",

    region: "Region",
    rank: "Rank",
    noRank: "Unranked",
    recentMatches: "Recent matches",
    noMatches: "No recent matches.",
    match: "Match",
    unknownMap: "Unknown map",
    unknownAgent: "Unknown agent",
    won: "Win",
    lost: "Loss",
    queueCompetitive: "Competitive",
    queueUnrated: "Unrated",
    queueSwiftplay: "Swiftplay",
    queueSpikeRush: "Spike Rush",
    queueDeathmatch: "Deathmatch",
    queueEscalation: "Escalation",
    queueTeamDeathmatch: "Team Deathmatch",

    level: "Level",
    queueSolo: "Solo/Duo",
    queueFlex: "Flex",
    leagueEntry: (tier, lp, wins, losses) => `${tier}, ${lp} LP (${wins}W/${losses}L)`,
    champion: (name, level, points) => `**${name}**, level ${level}, ${points} pts`,
    topChampions: "Top champions",
    noMastery: "No mastery data.",
  },
  de: {
    valorantDescription: "Valorant-Spielerstatistiken: Rang und letzte Matches",
    lolDescription: "League-of-Legends-Spielerstatistiken: Ränge und beste Champions",
    valorantIdOption: "Riot-ID, z. B. Name#TAG",
    lolIdOption:
      'Riot-ID, z. B. Name#TAG (mit Leerzeichen in Anführungszeichen: !lol "Name mit Leerzeichen#TAG" euw)',
    regionOption: "Spielserver (standardmäßig eune)",

    riotIdHelp: "Gib die Riot-ID als `Name#TAG` an.",
    statsOff: (game) => `Die ${game}-Statistiken sind aus: Der Bot hat keinen API-Schlüssel.`,
    unknownRegion: "Unbekannter Spielserver.",
    pause: (seconds) =>
      `Die Riot-API bittet um eine Pause. Versuch es in ${seconds} s noch einmal.`,
    cooldown: "Warte einen Moment bis zur nächsten Abfrage.",
    tooManyLookups:
      "Zu viele Anfragen an Riot in der letzten Minute. Versuch es gleich noch einmal.",
    notFound: (player) => `Ich habe den Spieler **${player}** nicht gefunden.`,
    noRegionProfile: (player, region) =>
      `Der Spieler **${player}** hat auf ${region === undefined ? "diesem Server" : `dem Server ${region}`} kein League-of-Legends-Konto. Versuch es mit einer anderen Region.`,
    forbiddenValorant:
      "Der Riot-API-Schlüssel hat keinen Zugriff auf diese Daten (ein Entwicklerschlüssel kann den Valorant-Matchverlauf nicht lesen).",
    forbiddenLol: "Der Riot-API-Schlüssel ist abgelaufen oder hat keinen Zugriff.",
    unavailable: "Die Riot-API antwortet nicht. Versuch es gleich noch einmal.",

    region: "Region",
    rank: "Rang",
    noRank: "Ohne Rang",
    recentMatches: "Letzte Matches",
    noMatches: "Keine letzten Matches.",
    match: "Match",
    unknownMap: "Unbekannte Karte",
    unknownAgent: "Unbekannter Agent",
    won: "Sieg",
    lost: "Niederlage",
    queueCompetitive: "Gewertet",
    queueUnrated: "Ungewertet",
    queueSwiftplay: "Swiftplay",
    queueSpikeRush: "Spike Rush",
    queueDeathmatch: "Deathmatch",
    queueEscalation: "Eskalation",
    queueTeamDeathmatch: "Team-Deathmatch",

    level: "Level",
    queueSolo: "Solo/Duo",
    queueFlex: "Flex",
    leagueEntry: (tier, lp, wins, losses) => `${tier}, ${lp} LP (${wins}S/${losses}N)`,
    champion: (name, level, points) => `**${name}**, Level ${level}, ${points} Punkte`,
    topChampions: "Beste Champions",
    noMastery: "Keine Meisterschaftsdaten.",
  },
});
