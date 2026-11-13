import { defineMessages } from "@dzajcarz/core";
import { MAX_MESSAGE_LENGTH } from "./template.ts";

/**
 * The module's own texts. The greeting itself is written by the server's admins and never translated, so the
 * placeholder below is only a hint of what to type.
 */
export const t = defineMessages({
  pl: {
    commandDescription: "Wiadomość powitalna dla nowych członków serwera",
    setDescription: "Ustawia kanał i treść powitania",
    setChannelOption: "Kanał z powitaniami",
    setMessageOption: "Treść: {user}, {username}, {server}, {memberCount}",
    offDescription: "Wyłącza powitania",
    testDescription: "Wysyła powitanie dla Ciebie na skonfigurowany kanał",

    formTitle: "Powitanie nowych członków",
    formChannel: "Kanał",
    formChannelHint: "Tu pojawi się powitanie.",
    formMessage: "Treść powitania",
    formMessageHint: `Zmienne: {user}, {username}, {server}, {memberCount}. Do ${MAX_MESSAGE_LENGTH} znaków.`,
    formPlaceholder: "Witaj {user} na {server}! Jesteś {memberCount}. osobą.",

    tooLong: `Powitanie może mieć najwyżej ${MAX_MESSAGE_LENGTH} znaków.`,
    empty: "Treść powitania nie może być pusta.",
    notTextChannel: "Wybierz kanał tekstowy z tego serwera.",
    saved: (channelId: string) =>
      `Nowi członkowie będą witani na <#${channelId}>. Sprawdź wygląd przez \`welcome test\`.`,
    setUsage: "Podaj kanał i treść: `welcome set <channel> <message...>`.",
    removed: "Powitania wyłączone.",
    wasNotSet: "Powitania nie były ustawione.",
    notSet: "Powitania nie są ustawione. Użyj `welcome set`.",
    noGuildData: "Nie mogę pobrać danych serwera.",
    cannotSend: (channelId: string) =>
      `Nie mogę wysłać wiadomości na <#${channelId}>. Sprawdź, czy kanał istnieje i czy bot może tam pisać.`,
    testSent: "Wysłano powitanie testowe.",
  },
  en: {
    commandDescription: "Welcome message for new members of the server",
    setDescription: "Sets the channel and the text of the greeting",
    setChannelOption: "Channel for the greetings",
    setMessageOption: "Text: {user}, {username}, {server}, {memberCount}",
    offDescription: "Turns the greetings off",
    testDescription: "Sends the greeting for you to the configured channel",

    formTitle: "Greeting for new members",
    formChannel: "Channel",
    formChannelHint: "The greeting will appear here.",
    formMessage: "Greeting text",
    formMessageHint: `Variables: {user}, {username}, {server}, {memberCount}. Up to ${MAX_MESSAGE_LENGTH} characters.`,
    formPlaceholder: "Welcome {user} to {server}! You are member number {memberCount}.",

    tooLong: `The greeting can be at most ${MAX_MESSAGE_LENGTH} characters long.`,
    empty: "The greeting can't be empty.",
    notTextChannel: "Pick a text channel of this server.",
    saved: (channelId) =>
      `New members will be greeted in <#${channelId}>. See how it looks with \`welcome test\`.`,
    setUsage: "Give a channel and a text: `welcome set <channel> <message...>`.",
    removed: "Greetings turned off.",
    wasNotSet: "Greetings were not set up.",
    notSet: "Greetings are not set up. Use `welcome set`.",
    noGuildData: "I can't fetch the server's data.",
    cannotSend: (channelId) =>
      `I can't send a message to <#${channelId}>. Check that the channel exists and that the bot may write there.`,
    testSent: "Sent the test greeting.",
  },
  de: {
    commandDescription: "Willkommensnachricht für neue Mitglieder des Servers",
    setDescription: "Legt Kanal und Text der Begrüßung fest",
    setChannelOption: "Kanal für die Begrüßungen",
    setMessageOption: "Text: {user}, {username}, {server}, {memberCount}",
    offDescription: "Schaltet die Begrüßungen aus",
    testDescription: "Schickt dir die Begrüßung im eingestellten Kanal zum Test",

    formTitle: "Begrüßung neuer Mitglieder",
    formChannel: "Kanal",
    formChannelHint: "Hier erscheint die Begrüßung.",
    formMessage: "Text der Begrüßung",
    formMessageHint: `Variablen: {user}, {username}, {server}, {memberCount}. Bis zu ${MAX_MESSAGE_LENGTH} Zeichen.`,
    formPlaceholder: "Willkommen {user} auf {server}! Du bist Mitglied Nummer {memberCount}.",

    tooLong: `Die Begrüßung darf höchstens ${MAX_MESSAGE_LENGTH} Zeichen lang sein.`,
    empty: "Der Text der Begrüßung darf nicht leer sein.",
    notTextChannel: "Wähl einen Textkanal dieses Servers.",
    saved: (channelId) =>
      `Neue Mitglieder werden in <#${channelId}> begrüßt. Wie das aussieht, zeigt \`welcome test\`.`,
    setUsage: "Gib Kanal und Text an: `welcome set <channel> <message...>`.",
    removed: "Begrüßungen ausgeschaltet.",
    wasNotSet: "Begrüßungen waren nicht eingerichtet.",
    notSet: "Begrüßungen sind nicht eingerichtet. Nutze `welcome set`.",
    noGuildData: "Ich kann die Serverdaten nicht abrufen.",
    cannotSend: (channelId) =>
      `Ich kann keine Nachricht an <#${channelId}> senden. Prüf, ob der Kanal existiert und der Bot dort schreiben darf.`,
    testSent: "Testbegrüßung gesendet.",
  },
});
