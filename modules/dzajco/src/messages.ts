import { defineMessages } from "@dzajcarz/core";

/** Every member-facing text of the Dżajco module. */
export const t = defineMessages({
  pl: {
    dzajcoDescription:
      "Ustawienia odpowiedzi Dżajco na „co?” w kanałach i w prywatnej rozmowie z botem",
    channelDescription: "Kanał, wątek albo czat głosowy (domyślnie ten, w którym piszesz)",
    showDescription: "Pokazuje ustawienia Dżajco kanału",
    setDescription: "Zmienia szansę i przerwę Dżajco w kanale",
    chanceDescription: "Szansa na odpowiedź w procentach (0 wyłącza Dżajco)",
    cooldownDescription:
      "Przerwa między odpowiedziami w sekundach (w prywatnej rozmowie co najmniej 10)",
    resetDescription: "Przywraca domyślne ustawienia Dżajco w kanale",
    dmOnlyThisConversation: "W prywatnej wiadomości ustawiasz tylko tę rozmowę.",
    pickChatChannel:
      "Wybierz kanał z tego serwera, na którym da się pisać (także wątek albo czat kanału głosowego).",
    giveChanceOrCooldown: "Podaj szansę albo przerwę.",
    hereDm: "w tej rozmowie",
    hereChannel: (channelId: string) => `na <#${channelId}>`,
    settings: (chancePercent: number, cooldownSeconds: number) =>
      `szansa ${chancePercent}%, przerwa ${cooldownSeconds} s`,
    inheritedFrom: (parentId: string) => ` (z kanału nadrzędnego <#${parentId}>)`,
    isDefault: " (domyślne)",
    status: (where: string, settings: string, source: string) =>
      `Dżajco ${where}: ${settings}${source}.`,
    resetDone: (where: string) => `Przywrócono domyślne ustawienia Dżajco ${where}.`,
    resetAlreadyDefault: (where: string) => `Ustawienia Dżajco ${where} były już domyślne.`,
  },
  en: {
    dzajcoDescription:
      "Settings for Dżajco's answer to “what?” in channels and in DMs with the bot",
    channelDescription: "Channel, thread or voice chat (defaults to the one you are writing in)",
    showDescription: "Shows the channel's Dżajco settings",
    setDescription: "Changes the channel's Dżajco chance and cooldown",
    chanceDescription: "Chance of answering, in percent (0 turns Dżajco off)",
    cooldownDescription: "Pause between answers in seconds (at least 10 in a DM)",
    resetDescription: "Restores the channel's default Dżajco settings",
    dmOnlyThisConversation: "In a DM you can only configure this conversation.",
    pickChatChannel:
      "Pick a channel of this server where people can write (a thread or a voice channel's chat works too).",
    giveChanceOrCooldown: "Give a chance or a cooldown.",
    hereDm: "in this conversation",
    hereChannel: (channelId: string) => `in <#${channelId}>`,
    settings: (chancePercent: number, cooldownSeconds: number) =>
      `${chancePercent}% chance, ${cooldownSeconds} s cooldown`,
    inheritedFrom: (parentId: string) => ` (from the parent channel <#${parentId}>)`,
    isDefault: " (default)",
    status: (where: string, settings: string, source: string) =>
      `Dżajco ${where}: ${settings}${source}.`,
    resetDone: (where: string) => `Restored the default Dżajco settings ${where}.`,
    resetAlreadyDefault: (where: string) =>
      `The Dżajco settings ${where} were already the default.`,
  },
  de: {
    dzajcoDescription:
      "Einstellungen für Dżajcos Antwort auf „co?“ in Kanälen und in privaten Chats mit dem Bot",
    channelDescription: "Kanal, Thread oder Sprachchat (Standard: der Kanal, in dem du schreibst)",
    showDescription: "Zeigt die Dżajco-Einstellungen des Kanals",
    setDescription: "Ändert Wahrscheinlichkeit und Pause von Dżajco im Kanal",
    chanceDescription: "Antwortwahrscheinlichkeit in Prozent (0 schaltet Dżajco aus)",
    cooldownDescription: "Pause zwischen Antworten in Sekunden (in privaten Chats mindestens 10)",
    resetDescription: "Stellt die Standard-Einstellungen von Dżajco im Kanal wieder her",
    dmOnlyThisConversation:
      "In einer privaten Nachricht kannst du nur diese Unterhaltung einstellen.",
    pickChatChannel:
      "Wähle einen Kanal dieses Servers, in dem geschrieben werden kann (auch ein Thread oder der Chat eines Sprachkanals).",
    giveChanceOrCooldown: "Gib eine Wahrscheinlichkeit oder eine Pause an.",
    hereDm: "in dieser Unterhaltung",
    hereChannel: (channelId: string) => `in <#${channelId}>`,
    settings: (chancePercent: number, cooldownSeconds: number) =>
      `${chancePercent} % Wahrscheinlichkeit, ${cooldownSeconds} s Pause`,
    inheritedFrom: (parentId: string) => ` (vom übergeordneten Kanal <#${parentId}>)`,
    isDefault: " (Standard)",
    status: (where: string, settings: string, source: string) =>
      `Dżajco ${where}: ${settings}${source}.`,
    resetDone: (where: string) =>
      `Die Standard-Einstellungen von Dżajco ${where} wurden wiederhergestellt.`,
    resetAlreadyDefault: (where: string) =>
      `Die Einstellungen von Dżajco ${where} waren bereits die Standardwerte.`,
  },
});
