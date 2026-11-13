import { defineMessages } from "@dzajcarz/core";

/**
 * Every text the bot itself writes in the messages module. The text of a scheduled message is written by a
 * member and is never translated.
 */
export const t = defineMessages({
  pl: {
    // Command metadata
    messagesDescription: "Zaplanowane wiadomości na serwerze",
    addDescription: "Planuje codzienną wiadomość na kanał albo w DM do członka serwera",
    addTimeOption: "Godzina HH:MM w strefie czasowej serwera (/timezone)",
    addTargetOption: "#kanał albo @osoba",
    addTextOption: "Treść ({user} oznacza odbiorcę DM)",
    listDescription: "Pokazuje zaplanowane wiadomości serwera",
    removeDescription: "Usuwa zaplanowaną wiadomość",
    removeIdOption: "Numer z `messages list`",
    dmDescription: "Zaplanowane wiadomości prywatne od bota",
    dmOffDescription: "Wyłącza je z tego serwera (w DM z botem: ze wszystkich)",
    dmOnDescription: "Włącza je dla tego serwera (w DM z botem: zdejmuje wyłączenie wszystkich)",
    // Form
    formTitle: "Zaplanowana wiadomość",
    formTimeLabel: "Godzina (strefa czasowa serwera)",
    formTimeDescription: "HH:MM, wiadomość wychodzi codziennie o tej porze.",
    formChannelLabel: "Kanał",
    formChannelDescription: "Wybierz kanał albo osobę poniżej.",
    formUserLabel: "Osoba (wiadomość prywatna)",
    formUserDescription: "Członek serwera, który dostanie DM.",
    formTextLabel: "Treść",
    formTextDescription: "{user} wstawia oznaczenie odbiorcy (tylko w DM).",
    formTextPlaceholder: "Bonżur!",
    // Errors
    badTime: "Podaj godzinę jako HH:MM, np. 19:00.",
    oneTarget: "Wybierz kanał albo osobę (jedno z dwóch).",
    badChannel: "Wybierz kanał tekstowy z tego serwera.",
    notAMember: "Wiadomości prywatne mogę wysyłać tylko członkom tego serwera (nie botom).",
    badLength: (max: number) => `Treść musi mieć od 1 do ${max} znaków.`,
    directOverflow: (limit: number, over: number) =>
      `Po wstawieniu oznaczeń {user} i stopki z nazwą serwera wiadomość prywatna przekroczy ${limit} znaków. Skróć ją o ${over}.`,
    limitReached: (max: number) =>
      `Ten serwer ma już ${max} zaplanowanych wiadomości. Usuń którąś przez \`messages remove\`.`,
    recipientFull: (max: number) =>
      `Ta osoba ma już ${max} zaplanowane wiadomości prywatne z tego serwera. Usuń którąś przez \`messages remove\`.`,
    duplicate: "Na ten kanał albo do tej osoby jest już zaplanowana wiadomość o tej godzinie.",
    cannotPost: (channelId: string) =>
      `Nie mogę pisać na <#${channelId}>. Daj mi tam uprawnienia „Wyświetlanie kanałów” i „Wysyłanie wiadomości”.`,
    staleButton: "Ten przycisk jest nieaktualny.",
    noSuchMessage: (id: number) => `Nie ma wiadomości #${id} na tym serwerze.`,
    // Replies
    scheduledDm: (id: number, when: string, userId: string) =>
      `Zaplanowano wiadomość #${id} na ${when} → DM do <@${userId}>.`,
    scheduledChannel: (id: number, when: string, channelId: string, note: string) =>
      `Zaplanowano wiadomość #${id} na ${when} → <#${channelId}>.${note}`,
    userInChannel:
      " `{user}` działa tylko w wiadomościach prywatnych, na kanale zostanie wpisane dosłownie.",
    emptyList: "Brak zaplanowanych wiadomości. Dodaj przez `messages add`.",
    listHeader: (zone: string) => `Godziny w strefie ${zone}:`,
    removed: (id: number) => `Usunięto wiadomość #${id}.`,
    optedOutOfServer: (name: string) =>
      `Nie dostaniesz już zaplanowanych wiadomości z ${name !== "" ? `serwera ${name}` : "tego serwera"}. Włączysz je z powrotem przez \`/dm on\` na tym serwerze.`,
    dmOffEverywhere: "Nie dostaniesz już zaplanowanych wiadomości z żadnego serwera.",
    dmOffHere: "Nie dostaniesz już zaplanowanych wiadomości z tego serwera.",
    dmOnEverywhere: "Włączone ponownie dla wszystkich serwerów, poza tymi wyłączonymi osobno.",
    dmOnEverywhereNone:
      "Nie masz wyłączenia dla wszystkich serwerów. Wyłączenie jednego serwera zdejmiesz przez `/dm on` na tym serwerze.",
    stillOptedOutAfterOn:
      "Włączono dla tego serwera, ale nadal masz wyłączone wiadomości ze wszystkich serwerów, więc stąd też nic nie przyjdzie. Wpisz `/dm on` w prywatnej wiadomości do bota, żeby to zmienić.",
    stillOptedOut:
      "Nadal masz wyłączone wiadomości ze wszystkich serwerów, więc stąd też nic nie przyjdzie. Wpisz `/dm on` w prywatnej wiadomości do bota, żeby to zmienić.",
    dmOnHere: "Znowu dostaniesz zaplanowane wiadomości z tego serwera.",
    dmOnNotOff: "Nie były wyłączone.",
    // In the DM
    dmFooter: (guildName: string) => `\n-# Zaplanowana wiadomość z serwera ${guildName}.`,
    optOutLabel: "Nie wysyłaj mi więcej",
  },
  en: {
    messagesDescription: "Scheduled messages on the server",
    addDescription: "Schedules a daily message to a channel or a DM to a server member",
    addTimeOption: "Time as HH:MM in the server's time zone (/timezone)",
    addTargetOption: "#channel or @person",
    addTextOption: "Text ({user} stands for the DM recipient)",
    listDescription: "Shows the server's scheduled messages",
    removeDescription: "Deletes a scheduled message",
    removeIdOption: "The number from `messages list`",
    dmDescription: "Scheduled direct messages from the bot",
    dmOffDescription: "Turns them off for this server (in a DM with the bot: for all servers)",
    dmOnDescription:
      "Turns them on for this server (in a DM with the bot: lifts the all-servers opt-out)",
    formTitle: "Scheduled message",
    formTimeLabel: "Time (server time zone)",
    formTimeDescription: "HH:MM, the message goes out every day at this time.",
    formChannelLabel: "Channel",
    formChannelDescription: "Pick a channel or a person below.",
    formUserLabel: "Person (direct message)",
    formUserDescription: "The server member who gets the DM.",
    formTextLabel: "Text",
    formTextDescription: "{user} inserts a mention of the recipient (DMs only).",
    formTextPlaceholder: "Good morning!",
    badTime: "Give the time as HH:MM, e.g. 19:00.",
    oneTarget: "Pick a channel or a person (one of the two).",
    badChannel: "Pick a text channel of this server.",
    notAMember: "I can only send direct messages to members of this server (not bots).",
    badLength: (max) => `The text must be 1 to ${max} characters long.`,
    directOverflow: (limit, over) =>
      `Once the {user} mentions and the footer with the server name are added, the direct message will go over ${limit} characters. Shorten it by ${over}.`,
    limitReached: (max) =>
      `This server already has ${max} scheduled messages. Delete one with \`messages remove\`.`,
    recipientFull: (max) =>
      `This person already has ${max} scheduled direct messages from this server. Delete one with \`messages remove\`.`,
    duplicate: "There is already a message scheduled at that time for this channel or person.",
    cannotPost: (channelId) =>
      `I can't post in <#${channelId}>. Give me the "View Channel" and "Send Messages" permissions there.`,
    staleButton: "This button is out of date.",
    noSuchMessage: (id) => `There is no message #${id} on this server.`,
    scheduledDm: (id, when, userId) => `Scheduled message #${id} for ${when} → DM to <@${userId}>.`,
    scheduledChannel: (id, when, channelId, note) =>
      `Scheduled message #${id} for ${when} → <#${channelId}>.${note}`,
    userInChannel: " `{user}` only works in direct messages; in a channel it is posted literally.",
    emptyList: "No scheduled messages. Add one with `messages add`.",
    listHeader: (zone) => `Times in the ${zone} zone:`,
    removed: (id) => `Deleted message #${id}.`,
    optedOutOfServer: (name) =>
      `You won't get scheduled messages from ${name !== "" ? `the server ${name}` : "this server"} anymore. Turn them back on with \`/dm on\` on that server.`,
    dmOffEverywhere: "You won't get scheduled messages from any server anymore.",
    dmOffHere: "You won't get scheduled messages from this server anymore.",
    dmOnEverywhere: "Turned back on for all servers, except those you turned off separately.",
    dmOnEverywhereNone:
      "You haven't turned them off for all servers. To undo the opt-out of a single server, use `/dm on` on that server.",
    stillOptedOutAfterOn:
      "Turned on for this server, but you still have messages from all servers turned off, so nothing will arrive from here either. Use `/dm on` in a direct message to the bot to change that.",
    stillOptedOut:
      "You still have messages from all servers turned off, so nothing will arrive from here either. Use `/dm on` in a direct message to the bot to change that.",
    dmOnHere: "You'll get scheduled messages from this server again.",
    dmOnNotOff: "They weren't turned off.",
    dmFooter: (guildName) => `\n-# Scheduled message from the server ${guildName}.`,
    optOutLabel: "Don't send me more",
  },
  de: {
    messagesDescription: "Geplante Nachrichten auf dem Server",
    addDescription:
      "Plant eine tägliche Nachricht in einen Kanal oder als DM an ein Servermitglied",
    addTimeOption: "Uhrzeit als HH:MM in der Zeitzone des Servers (/timezone)",
    addTargetOption: "#Kanal oder @Person",
    addTextOption: "Text ({user} steht für den DM-Empfänger)",
    listDescription: "Zeigt die geplanten Nachrichten des Servers",
    removeDescription: "Löscht eine geplante Nachricht",
    removeIdOption: "Die Nummer aus `messages list`",
    dmDescription: "Geplante Direktnachrichten vom Bot",
    dmOffDescription: "Schaltet sie für diesen Server aus (in einer DM mit dem Bot: für alle)",
    dmOnDescription:
      "Schaltet sie für diesen Server ein (in einer DM mit dem Bot: hebt die Abmeldung von allen auf)",
    formTitle: "Geplante Nachricht",
    formTimeLabel: "Uhrzeit (Zeitzone des Servers)",
    formTimeDescription: "HH:MM, die Nachricht kommt täglich zu dieser Zeit.",
    formChannelLabel: "Kanal",
    formChannelDescription: "Wähle unten einen Kanal oder eine Person.",
    formUserLabel: "Person (Direktnachricht)",
    formUserDescription: "Das Servermitglied, das die DM bekommt.",
    formTextLabel: "Text",
    formTextDescription: "{user} fügt eine Erwähnung des Empfängers ein (nur in DMs).",
    formTextPlaceholder: "Guten Morgen!",
    badTime: "Gib die Uhrzeit als HH:MM an, z. B. 19:00.",
    oneTarget: "Wähle einen Kanal oder eine Person (eins von beiden).",
    badChannel: "Wähle einen Textkanal dieses Servers.",
    notAMember:
      "Direktnachrichten kann ich nur an Mitglieder dieses Servers schicken (nicht an Bots).",
    badLength: (max) => `Der Text muss 1 bis ${max} Zeichen lang sein.`,
    directOverflow: (limit, over) =>
      `Mit den eingesetzten {user}-Erwähnungen und der Fußzeile mit dem Servernamen ist die Direktnachricht länger als ${limit} Zeichen. Kürze sie um ${over}.`,
    limitReached: (max) =>
      `Dieser Server hat schon ${max} geplante Nachrichten. Lösche eine mit \`messages remove\`.`,
    recipientFull: (max) =>
      `Diese Person hat von diesem Server schon ${max} geplante Direktnachrichten. Lösche eine mit \`messages remove\`.`,
    duplicate:
      "Für diesen Kanal oder diese Person ist zu dieser Uhrzeit schon eine Nachricht geplant.",
    cannotPost: (channelId) =>
      `Ich kann in <#${channelId}> nicht schreiben. Gib mir dort die Rechte „Kanal ansehen“ und „Nachrichten senden“.`,
    staleButton: "Diese Schaltfläche ist veraltet.",
    noSuchMessage: (id) => `Auf diesem Server gibt es keine Nachricht #${id}.`,
    scheduledDm: (id, when, userId) => `Nachricht #${id} für ${when} geplant → DM an <@${userId}>.`,
    scheduledChannel: (id, when, channelId, note) =>
      `Nachricht #${id} für ${when} geplant → <#${channelId}>.${note}`,
    userInChannel:
      " `{user}` funktioniert nur in Direktnachrichten; in einem Kanal wird es wörtlich gepostet.",
    emptyList: "Keine geplanten Nachrichten. Füge eine mit `messages add` hinzu.",
    listHeader: (zone) => `Uhrzeiten in der Zeitzone ${zone}:`,
    removed: (id) => `Nachricht #${id} gelöscht.`,
    optedOutOfServer: (name) =>
      `Du bekommst keine geplanten Nachrichten mehr von ${name !== "" ? `dem Server ${name}` : "diesem Server"}. Schalte sie mit \`/dm on\` auf diesem Server wieder ein.`,
    dmOffEverywhere: "Du bekommst keine geplanten Nachrichten mehr von irgendeinem Server.",
    dmOffHere: "Du bekommst keine geplanten Nachrichten mehr von diesem Server.",
    dmOnEverywhere:
      "Für alle Server wieder eingeschaltet, außer für die, die du einzeln ausgeschaltet hast.",
    dmOnEverywhereNone:
      "Du hast sie nicht für alle Server ausgeschaltet. Die Abmeldung von einem einzelnen Server hebst du mit `/dm on` auf diesem Server auf.",
    stillOptedOutAfterOn:
      "Für diesen Server eingeschaltet, aber du hast Nachrichten von allen Servern noch ausgeschaltet, deshalb kommt auch von hier nichts an. Gib `/dm on` in einer Direktnachricht an den Bot ein, um das zu ändern.",
    stillOptedOut:
      "Du hast Nachrichten von allen Servern noch ausgeschaltet, deshalb kommt auch von hier nichts an. Gib `/dm on` in einer Direktnachricht an den Bot ein, um das zu ändern.",
    dmOnHere: "Du bekommst wieder geplante Nachrichten von diesem Server.",
    dmOnNotOff: "Sie waren nicht ausgeschaltet.",
    dmFooter: (guildName) => `\n-# Geplante Nachricht vom Server ${guildName}.`,
    optOutLabel: "Keine mehr senden",
  },
});
