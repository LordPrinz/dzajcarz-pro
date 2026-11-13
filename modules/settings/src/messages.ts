import { defineMessages } from "@dzajcarz/core";

/** Every member-facing text of the settings module. */
export const t = defineMessages({
  pl: {
    // /prefix
    prefixDescription: "Pokazuje albo zmienia prefiks komend na tym serwerze",
    prefixSetDescription: "Ustawia prefiks komend tekstowych",
    prefixOption: "Nowy prefiks (1-5 znaków)",
    prefixResetDescription: "Przywraca domyślny prefiks",
    prefixShowDescription: "Pokazuje aktualny prefiks",
    prefixSet: (prefix: string) => `Prefiks to teraz \`${prefix}\`.`,
    prefixReset: (prefix: string) => `Przywrócono domyślny prefiks \`${prefix}\`.`,
    prefixShow: (prefix: string) =>
      `Prefiks na tym serwerze to \`${prefix}\`. Możesz też wspomnieć bota.`,
    prefixLength: (max: number) => `Prefiks musi mieć od 1 do ${max} znaków.`,
    prefixWhitespace: "Prefiks nie może zawierać spacji ani niewidocznych znaków.",
    prefixBacktick: "Prefiks nie może zawierać znaku `.",
    // /timezone
    zoneDescription: "Strefa czasowa serwera: zaplanowane wiadomości i piosenki, /time, daty",
    zoneSetDescription: "Ustawia strefę czasową serwera",
    zoneOption: "Nazwa strefy IANA, np. Europe/Warsaw, Europe/London, America/New_York",
    zoneResetDescription: "Przywraca domyślną strefę czasową",
    zoneShowDescription: "Pokazuje strefę czasową serwera",
    zone: (zone: string, clock: string) => `\`${zone}\` (teraz ${clock})`,
    unknownZone: (zone: string) =>
      `Nie znam strefy \`${zone}\`. Podaj nazwę IANA, np. \`Europe/Warsaw\`, \`Europe/London\` albo \`America/New_York\`.`,
    zoneSet: (zone: string) =>
      `Strefa czasowa serwera to teraz ${zone}. Zaplanowane wiadomości i piosenki idą według niej.`,
    zoneReset: (zone: string) => `Przywrócono domyślną strefę ${zone}.`,
    zoneShow: (zone: string, isDefault: boolean) =>
      `Strefa czasowa serwera: ${zone}${isDefault ? " (domyślna)" : ""}.`,
    // /modules
    modulesDescription: "Włącza i wyłącza moduły bota na serwerze, w kanale albo w kategorii",
    modulesListDescription: "Pokazuje moduły i miejsca, w których są wyłączone",
    modulesDisableDescription: "Wyłącza moduł na serwerze, w kanale albo w całej kategorii",
    modulesEnableDescription: "Włącza moduł z powrotem na serwerze, w kanale albo w kategorii",
    moduleOption: "Nazwa modułu",
    channelOption: "Kanał lub kategoria (domyślnie cały serwer)",
    moduleOn: (module: string) => `\`${module}\`: włączony`,
    moduleOffServer: (module: string) => `\`${module}\`: wyłączony na serwerze`,
    moduleOffIn: (module: string, channels: string, hidden: number) =>
      `\`${module}\`: wyłączony w ${channels}${hidden > 0 ? ` i jeszcze ${hidden}` : ""}`,
    unknownModule: (module: string, valid: string) =>
      `Nie ma modułu \`${module}\`. Dostępne moduły: ${valid || "brak"}.`,
    protectedModule: (module: string) => `Modułu \`${module}\` nie można wyłączyć.`,
    channelNotFound: "Nie znalazłem takiego kanału na tym serwerze.",
    threadChannel:
      "Wątki dziedziczą ustawienia kanału nadrzędnego. Wybierz kanał, w którym wątek leży.",
    inChannel: (channelId: string) => `w <#${channelId}>`,
    onServer: "na serwerze",
    dmNote: " Zaplanowane wiadomości prywatne wyłączysz tylko na całym serwerze.",
    moduleDisabled: (module: string, where: string, note: string) =>
      `Moduł \`${module}\` jest wyłączony ${where}.${note}`,
    moduleEnabled: (module: string, where: string) =>
      `Moduł \`${module}\` jest znów włączony ${where}.`,
    moduleNotDisabled: (module: string, where: string) =>
      `Moduł \`${module}\` nie był wyłączony ${where}.`,
    // /language
    languageDescription: "Język bota na tym serwerze albo w Twoich prywatnych wiadomościach",
    languageOption: "Nowy język (bez niego pokażę obecny)",
    languageDefault: "Domyślny",
    languageNeedsManageGuild:
      "Język serwera może zmienić tylko ktoś z uprawnieniem Zarządzanie serwerem.",
    languageOfGuild: (name: string, chosen: boolean) =>
      `Język bota na tym serwerze: **${name}**${chosen ? "" : " (domyślny)"}.`,
    languageOfUser: (name: string, chosen: boolean) =>
      chosen
        ? `Piszę do Ciebie w języku: **${name}**.`
        : `Piszę do Ciebie w języku: **${name}**. Nie wybrałeś go, więc biorę język Twojego Discorda albo polski.`,
    languageSetGuild: "Od teraz mówię na tym serwerze po polsku.",
    languageSetUser: "Od teraz piszę do Ciebie po polsku.",
    languageResetGuild: "Przywrócono domyślny język serwera: polski.",
    languageResetUser:
      "Zapomniałem Twój wybór. Piszę w języku Twojego Discorda, a gdy go nie znam, po polsku.",
  },
  en: {
    prefixDescription: "Shows or changes the command prefix on this server",
    prefixSetDescription: "Sets the prefix for text commands",
    prefixOption: "New prefix (1-5 characters)",
    prefixResetDescription: "Restores the default prefix",
    prefixShowDescription: "Shows the current prefix",
    prefixSet: (prefix) => `The prefix is now \`${prefix}\`.`,
    prefixReset: (prefix) => `Restored the default prefix \`${prefix}\`.`,
    prefixShow: (prefix) =>
      `The prefix on this server is \`${prefix}\`. You can also mention the bot.`,
    prefixLength: (max) => `The prefix must be 1 to ${max} characters long.`,
    prefixWhitespace: "The prefix can't contain spaces or invisible characters.",
    prefixBacktick: "The prefix can't contain the ` character.",
    zoneDescription: "The server's time zone: scheduled messages and songs, /time, dates",
    zoneSetDescription: "Sets the server's time zone",
    zoneOption: "IANA zone name, e.g. Europe/Warsaw, Europe/London, America/New_York",
    zoneResetDescription: "Restores the default time zone",
    zoneShowDescription: "Shows the server's time zone",
    zone: (zone, clock) => `\`${zone}\` (now ${clock})`,
    unknownZone: (zone) =>
      `I don't know the zone \`${zone}\`. Give an IANA name, e.g. \`Europe/Warsaw\`, \`Europe/London\` or \`America/New_York\`.`,
    zoneSet: (zone) =>
      `The server's time zone is now ${zone}. Scheduled messages and songs follow it.`,
    zoneReset: (zone) => `Restored the default zone ${zone}.`,
    zoneShow: (zone, isDefault) => `Server time zone: ${zone}${isDefault ? " (default)" : ""}.`,
    modulesDescription:
      "Turns the bot's modules on and off on the server, in a channel or category",
    modulesListDescription: "Shows the modules and where they are turned off",
    modulesDisableDescription: "Turns a module off on the server, in a channel or a whole category",
    modulesEnableDescription: "Turns a module back on on the server, in a channel or category",
    moduleOption: "Module name",
    channelOption: "Channel or category (default: the whole server)",
    moduleOn: (module) => `\`${module}\`: on`,
    moduleOffServer: (module) => `\`${module}\`: off on the server`,
    moduleOffIn: (module, channels, hidden) =>
      `\`${module}\`: off in ${channels}${hidden > 0 ? ` and ${hidden} more` : ""}`,
    unknownModule: (module, valid) =>
      `There is no module \`${module}\`. Available modules: ${valid || "none"}.`,
    protectedModule: (module) => `The \`${module}\` module can't be turned off.`,
    channelNotFound: "I couldn't find that channel on this server.",
    threadChannel:
      "Threads follow the settings of their parent channel. Pick the channel the thread is in.",
    inChannel: (channelId) => `in <#${channelId}>`,
    onServer: "on the server",
    dmNote: " Scheduled direct messages can only be turned off for the whole server.",
    moduleDisabled: (module, where, note) => `The \`${module}\` module is off ${where}.${note}`,
    moduleEnabled: (module, where) => `The \`${module}\` module is back on ${where}.`,
    moduleNotDisabled: (module, where) => `The \`${module}\` module wasn't off ${where}.`,
    languageDescription: "The bot's language on this server or in your direct messages",
    languageOption: "The new language (leave it out to see the current one)",
    languageDefault: "Default",
    languageNeedsManageGuild: "Only members with Manage Server can change the server's language.",
    languageOfGuild: (name, chosen) =>
      `The bot's language on this server: **${name}**${chosen ? "" : " (default)"}.`,
    languageOfUser: (name, chosen) =>
      chosen
        ? `I write to you in **${name}**.`
        : `I write to you in **${name}**. You haven't picked one, so I use your Discord language or Polish.`,
    languageSetGuild: "From now on I speak English on this server.",
    languageSetUser: "From now on I'll write to you in English.",
    languageResetGuild: "Restored the server's default language: Polish.",
    languageResetUser:
      "I forgot your choice. I'll use your Discord language, or Polish if I don't speak it.",
  },
  de: {
    prefixDescription: "Zeigt oder ändert das Befehlspräfix auf diesem Server",
    prefixSetDescription: "Legt das Präfix für Textbefehle fest",
    prefixOption: "Neues Präfix (1-5 Zeichen)",
    prefixResetDescription: "Stellt das Standardpräfix wieder her",
    prefixShowDescription: "Zeigt das aktuelle Präfix",
    prefixSet: (prefix) => `Das Präfix ist jetzt \`${prefix}\`.`,
    prefixReset: (prefix) => `Das Standardpräfix \`${prefix}\` ist wiederhergestellt.`,
    prefixShow: (prefix) =>
      `Das Präfix auf diesem Server ist \`${prefix}\`. Du kannst den Bot auch erwähnen.`,
    prefixLength: (max) => `Das Präfix muss 1 bis ${max} Zeichen lang sein.`,
    prefixWhitespace: "Das Präfix darf keine Leerzeichen oder unsichtbaren Zeichen enthalten.",
    prefixBacktick: "Das Präfix darf das Zeichen ` nicht enthalten.",
    zoneDescription: "Zeitzone des Servers: geplante Nachrichten und Lieder, /time, Daten",
    zoneSetDescription: "Legt die Zeitzone des Servers fest",
    zoneOption: "IANA-Zonenname, z. B. Europe/Berlin, Europe/London, America/New_York",
    zoneResetDescription: "Stellt die Standardzeitzone wieder her",
    zoneShowDescription: "Zeigt die Zeitzone des Servers",
    zone: (zone, clock) => `\`${zone}\` (jetzt ${clock})`,
    unknownZone: (zone) =>
      `Die Zone \`${zone}\` kenne ich nicht. Gib einen IANA-Namen an, z. B. \`Europe/Berlin\`, \`Europe/London\` oder \`America/New_York\`.`,
    zoneSet: (zone) =>
      `Die Zeitzone des Servers ist jetzt ${zone}. Geplante Nachrichten und Lieder richten sich danach.`,
    zoneReset: (zone) => `Die Standardzone ${zone} ist wiederhergestellt.`,
    zoneShow: (zone, isDefault) =>
      `Zeitzone des Servers: ${zone}${isDefault ? " (Standard)" : ""}.`,
    modulesDescription:
      "Schaltet Module des Bots auf dem Server, in einem Kanal oder einer Kategorie ein und aus",
    modulesListDescription: "Zeigt die Module und wo sie ausgeschaltet sind",
    modulesDisableDescription:
      "Schaltet ein Modul auf dem Server, in einem Kanal oder einer ganzen Kategorie aus",
    modulesEnableDescription:
      "Schaltet ein Modul auf dem Server, in einem Kanal oder einer Kategorie wieder ein",
    moduleOption: "Name des Moduls",
    channelOption: "Kanal oder Kategorie (Standard: der ganze Server)",
    moduleOn: (module) => `\`${module}\`: an`,
    moduleOffServer: (module) => `\`${module}\`: auf dem Server aus`,
    moduleOffIn: (module, channels, hidden) =>
      `\`${module}\`: aus in ${channels}${hidden > 0 ? ` und ${hidden} weiteren` : ""}`,
    unknownModule: (module, valid) =>
      `Es gibt kein Modul \`${module}\`. Verfügbare Module: ${valid || "keine"}.`,
    protectedModule: (module) => `Das Modul \`${module}\` lässt sich nicht ausschalten.`,
    channelNotFound: "Diesen Kanal habe ich auf dem Server nicht gefunden.",
    threadChannel:
      "Threads übernehmen die Einstellungen ihres Kanals. Wähl den Kanal, in dem der Thread liegt.",
    inChannel: (channelId) => `in <#${channelId}>`,
    onServer: "auf dem Server",
    dmNote: " Geplante Direktnachrichten lassen sich nur für den ganzen Server ausschalten.",
    moduleDisabled: (module, where, note) => `Das Modul \`${module}\` ist ${where} aus.${note}`,
    moduleEnabled: (module, where) => `Das Modul \`${module}\` ist ${where} wieder an.`,
    moduleNotDisabled: (module, where) => `Das Modul \`${module}\` war ${where} nicht aus.`,
    languageDescription: "Die Sprache des Bots auf diesem Server oder in deinen Direktnachrichten",
    languageOption: "Die neue Sprache (weglassen, um die aktuelle zu sehen)",
    languageDefault: "Standard",
    languageNeedsManageGuild:
      "Nur Mitglieder mit der Berechtigung „Server verwalten“ können die Sprache des Servers ändern.",
    languageOfGuild: (name, chosen) =>
      `Sprache des Bots auf diesem Server: **${name}**${chosen ? "" : " (Standard)"}.`,
    languageOfUser: (name, chosen) =>
      chosen
        ? `Ich schreibe dir auf **${name}**.`
        : `Ich schreibe dir auf **${name}**. Du hast keine gewählt, also nehme ich die Sprache deines Discord oder Polnisch.`,
    languageSetGuild: "Ab jetzt spreche ich auf diesem Server Deutsch.",
    languageSetUser: "Ab jetzt schreibe ich dir auf Deutsch.",
    languageResetGuild: "Die Standardsprache des Servers ist wiederhergestellt: Polnisch.",
    languageResetUser:
      "Ich habe deine Wahl vergessen. Ich nehme die Sprache deines Discord oder Polnisch, wenn ich sie nicht spreche.",
  },
});
