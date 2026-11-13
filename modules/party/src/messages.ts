import { defineMessages } from "@dzajcarz/core";
import { SPECIAL_MAX_MEMBERS, USER_PLACEHOLDER } from "./constants.ts";

/** Every member-facing text of the party module. Channel name templates typed by members are not here. */
export const t = defineMessages({
  pl: {
    // /party
    partyDescription: "Strefa imprezowa: kanały głosowe tworzone na życzenie",
    createDescription: "Tworzy kategorię z kanałem, na który wchodzi się po własny kanał głosowy",
    createNameOption: "Nazwa kategorii",
    editDescription: "Zmienia nazwy i ustawienia strefy imprezowej w formularzu",
    deleteDescription: "Usuwa strefę imprezową razem z jej kanałami",
    areaChannelOption: "Kanał wejściowy strefy (gdy jest ich kilka)",
    lockDescription: "Zamyka twój kanał dla nowych osób",
    unlockDescription: "Otwiera twój kanał z powrotem",
    limitDescription: "Ustawia limit osób na twoim kanale (0 = bez limitu)",
    limitOption: "Limit osób, 0 = bez limitu",
    renameDescription: "Zmienia nazwę twojego kanału",
    renameOption: "Nowa nazwa",
    inviteDescription: "Wpuszcza wskazaną osobę na twój kanał, nawet zamknięty lub ukryty",
    inviteOption: "Kogo zaprosić",
    inviteSpecialDescription: "Wysyła formularz-zaproszenie (wiadomość, załącznik) wybranym osobom",
    blockDescription: "Blokuje wskazaną osobę na twoim kanale i wyrzuca ją, jeśli tam jest",
    blockOption: "Kogo zablokować",
    hideDescription: "Ukrywa twój kanał na liście",
    showDescription: "Pokazuje twój kanał na liście",
    // Area form
    areaTitle: "Strefa imprezowa",
    categoryLabel: "Nazwa kategorii",
    categoryPlaceholder: "Impreza",
    joinChannelLabel: "Nazwa kanału wejściowego",
    templateLabel: "Szablon nazwy kanału",
    templateDescription: "{user} zamieni się w nazwę osoby, która wchodzi",
    commandChannelLabel: "Kanał komend",
    commandChannelOn: "Włączony",
    commandChannelOff: "Wyłączony",
    // Names the bot invents
    defaultTemplate: `Kanał ${USER_PLACEHOLDER}`,
    defaultJoinChannelName: "➕ Dołącz, by stworzyć kanał",
    fallbackChannelName: "Kanał imprezowy",
    // Areas
    noGuildPermission:
      "Do tego potrzebujesz uprawnienia Zarządzanie kanałami na całym serwerze, nie tylko na jednym kanale.",
    createFailed:
      "Nie mogę utworzyć kanałów. Sprawdź, czy bot ma uprawnienia „Zarządzanie kanałami”, „Przenoszenie członków” i „Zarządzanie rolami” (nadpisania uprawnień).",
    areaSaved: "Strefa imprezowa zaktualizowana.",
    areaUnreadable:
      "Ustawienia zapisane, ale nie mogę odczytać kanałów tej strefy, więc ich nazw nie zmieniono.",
    nameDone: (kind: "category" | "join") =>
      kind === "category" ? "nazwę kategorii" : "nazwę kanału wejściowego",
    nameNotDone: (kind: "category" | "join") =>
      kind === "category" ? "nazwy kategorii" : "nazwy kanału wejściowego",
    and: " i ",
    renameFailed: (names: string) =>
      `nie udało się zmienić ${names} (sprawdź uprawnienie „Zarządzanie kanałami”)`,
    renameLimited: (names: string, max: number) =>
      `${names} nie zmieniono: Discord pozwala zmienić nazwę ${max} razy na 10 minut`,
    settingsSaved: (renamed: string | undefined, problems: string) =>
      `Ustawienia zapisane${renamed ? `, zmieniono ${renamed}` : ""}, ale ${problems}.`,
    areaReady: (joinChannelId: string) =>
      `Strefa imprezowa gotowa. Wejdź na <#${joinChannelId}>, a dostaniesz własny kanał głosowy.`,
    areaGone: "Ta strefa już nie istnieje.",
    editNeedsSlash: "Edycja strefy wymaga komendy ukośnikowej: użyj /party edit.",
    areaChannelsMissing: "Nie mogę odczytać kanałów tej strefy. Sprawdź, czy nie zostały usunięte.",
    areaDeleted: "Strefa imprezowa usunięta.",
    inviteSpecialNeedsSlash:
      "Specjalne zaproszenie wymaga komendy ukośnikowej: użyj /party invite-special.",
    notAreaEntrance: "Ten kanał nie jest wejściem do strefy imprezowej.",
    noArea: "Na tym serwerze nie ma strefy imprezowej.",
    severalAreas: (list: string, purpose: "edit" | "delete") =>
      `Jest kilka stref (${list}). Wskaż kanał wejściowy strefy ${purpose === "edit" ? "do edycji" : "do usunięcia"}.`,
    // Names
    templateEmpty: "Szablon nazwy nie może być pusty.",
    templateTooLong: (max: number) => `Szablon nazwy może mieć najwyżej ${max} znaków.`,
    templateNeedsUser: (placeholder: string, example: string) =>
      `Szablon nazwy musi zawierać ${placeholder}, np. „${example}”.`,
    categoryNameRequired: "Podaj nazwę kategorii.",
    joinNameRequired: "Podaj nazwę kanału wejściowego.",
    nameTooLong: (max: number) => `Nazwa może mieć najwyżej ${max} znaków.`,
    // Owner controls
    limitTitle: "Limit osób",
    limitLabel: "Limit osób (0 = bez limitu)",
    limitRange: (max: number) => `Limit osób to liczba od 0 do ${max}.`,
    renameTitle: "Zmień nazwę kanału",
    renameLabel: "Nowa nazwa",
    locked: "Kanał zamknięty. Wejdą tylko zaproszeni.",
    unlocked: "Kanał otwarty.",
    hidden: "Kanał ukryty.",
    shown: "Kanał znów widoczny.",
    limitRemoved: "Limit osób usunięty.",
    limitSet: (count: number) => `Limit osób ustawiony na ${count}.`,
    nameRequired: "Podaj nową nazwę kanału.",
    nameInvisible: "Nazwa musi zawierać widoczne znaki.",
    nameUnchanged: (name: string) => `Nazwa kanału już brzmi „${name}”.`,
    renameRateLimit: (max: number) => `Discord pozwala zmienić nazwę ${max} razy na 10 minut.`,
    renamed: (name: string) => `Nazwa kanału zmieniona na „${name}”.`,
    invited: (userId: string) => `<@${userId}> może wejść na kanał.`,
    cannotBlockOwner: "Nie można zablokować właściciela kanału.",
    cannotBlockModerator: "Nie możesz zablokować moderatora.",
    blocked: (userId: string) => `<@${userId}> jest zablokowany na kanale.`,
    notInOwnChannel: "Musisz być na swoim kanale party.",
    ownerOnly: "Tylko właściciel kanału może to zrobić.",
    notYourself: "Nie możesz zrobić tego sam sobie.",
    notOnServer: "Nie ma takiej osoby na tym serwerze.",
    notTheBot: "Tego nie zrobię botowi.",
    // Limits
    specialUnavailable: "Specjalne zaproszenia są chwilowo niedostępne.",
    specialMinute: "Specjalne zaproszenie możesz wysłać raz na minutę. Spróbuj za chwilę.",
    specialHour: (max: number) =>
      `Specjalne zaproszenia możesz wysłać najwyżej ${max} razy na godzinę.`,
    tooManyChanges: "Za dużo zmian naraz. Spróbuj ponownie za chwilę.",
    // Panel
    panelTitle: "Panel kanału party",
    panelDescription:
      "Przyciski sterują twoim kanałem głosowym: wejdź na niego i wybierz akcję. " +
      "„Specjalne zaproszenie” otwiera formularz z wiadomością i załącznikiem dla wybranych osób. " +
      "Odpowiedzi widzisz tylko ty, a wiadomości na tym czacie znikają po 15 sekundach.",
    buttonLock: "Zamknij",
    buttonUnlock: "Otwórz",
    buttonHide: "Ukryj",
    buttonShow: "Pokaż",
    buttonLimit: "Limit",
    buttonRename: "Zmień nazwę",
    buttonSpecial: "Specjalne zaproszenie",
    selectInvite: "Zaproś osobę…",
    selectBlock: "Zablokuj osobę…",
    panelOutdated: "Ten panel jest nieaktualny. Poproś administratora o nowy.",
    panelProblem:
      "Nie udało się zaktualizować panelu w kanale komend. Sprawdź, czy bot może tam pisać i usuwać wiadomości.",
    // Special invites: form
    specialTitle: "Specjalne zaproszenie",
    specialMembersLabel: `Kogo zaprosić (1-${SPECIAL_MAX_MEMBERS} osób)`,
    specialTitleLabel: "Tytuł",
    specialTitlePlaceholder: "Domyślnie: Zaproszenie na imprezę",
    specialMessageLabel: "Wiadomość",
    specialMessagePlaceholder: "Domyślnie: krótkie zaproszenie na twój kanał",
    specialColourLabel: "Kolor",
    colourBlue: "Niebieski",
    colourRed: "Czerwony",
    colourOrange: "Pomarańczowy",
    colourYellow: "Żółty",
    colourGreen: "Zielony",
    colourPurple: "Fioletowy",
    colourPink: "Różowy",
    colourWhite: "Biały",
    specialAttachmentLabel: "Załącznik",
    specialAttachmentDescription:
      "Obraz, film lub PDF. Obraz pokaże się w zaproszeniu, reszta dojdzie jako plik.",
    specialOwnerOnly: "Tylko właściciel kanału może wysłać specjalne zaproszenie.",
    // Special invites: summary for the owner
    skipRecipientLimit: "limit zaproszeń dla tej osoby",
    skipLimitUnchecked: "nie udało się sprawdzić limitu",
    skipSelf: "to ty",
    skipMissing: "nie ma na serwerze",
    skipBot: "to bot",
    skipBlocked: "zablokowano na kanale",
    skipCheckFailed: "nie udało się sprawdzić",
    skipNoAccess: "nie udało się nadać dostępu",
    summaryDelivered: (count: number, mentions: string) =>
      `Zaproszenie dostarczone (${count}): ${mentions}`,
    summaryDmFailed: (count: number, mentions: string) =>
      `Wiadomość prywatna nie doszła (${count}): ${mentions}. ` +
      "Mimo to mogą wejść na kanał (dostęp zostaje), ale zaproszenia nie dostały: daj im znać sam.",
    summarySkipped: (count: number, list: string) => `Pominięte (${count}): ${list}`,
    summaryAttachmentLost: "Załącznika nie udało się pobrać, zaproszenia poszły bez niego.",
    // Special invites: the DM
    dmByline: (name: string) => `Zaproszenie od ${name}`,
    dmBylineFrom: (name: string, username: string, guildName: string) =>
      `Zaproszenie od ${name} (@${username}) z serwera ${guildName}`,
    dmTitle: "Zaproszenie na imprezę",
    dmDescription: (name: string) => `${name} zaprasza cię na swój kanał.`,
    dmChannelField: "Kanał",
    dmChannelFallback: "kanał party",
    dmFooter: "Treść napisał zapraszający, nie bot.",
    dmJoin: "Dołącz",
  },
  en: {
    // /party
    partyDescription: "Party zone: voice channels created on demand",
    createDescription:
      "Creates a category with a channel members join to get their own voice channel",
    createNameOption: "Category name",
    editDescription: "Changes the names and settings of the party zone in a form",
    deleteDescription: "Deletes the party zone together with its channels",
    areaChannelOption: "The zone's join channel (when there are several)",
    lockDescription: "Closes your channel to new people",
    unlockDescription: "Opens your channel again",
    limitDescription: "Sets the user limit on your channel (0 = no limit)",
    limitOption: "User limit, 0 = no limit",
    renameDescription: "Renames your channel",
    renameOption: "New name",
    inviteDescription: "Lets the chosen person into your channel, even when it is locked or hidden",
    inviteOption: "Who to invite",
    inviteSpecialDescription:
      "Sends an invitation form (message, attachment) to the people you pick",
    blockDescription:
      "Blocks the chosen person from your channel and kicks them out if they are in it",
    blockOption: "Who to block",
    hideDescription: "Hides your channel from the list",
    showDescription: "Shows your channel in the list",
    // Area form
    areaTitle: "Party zone",
    categoryLabel: "Category name",
    categoryPlaceholder: "Party",
    joinChannelLabel: "Join channel name",
    templateLabel: "Channel name template",
    templateDescription: "{user} becomes the name of the person who joins",
    commandChannelLabel: "Command channel",
    commandChannelOn: "On",
    commandChannelOff: "Off",
    // Names the bot invents
    defaultTemplate: `${USER_PLACEHOLDER}'s channel`,
    defaultJoinChannelName: "➕ Join to create a channel",
    fallbackChannelName: "Party channel",
    // Areas
    noGuildPermission:
      "You need the Manage Channels permission on the whole server for this, not just on one channel.",
    createFailed:
      "I can't create the channels. Check that the bot has the “Manage Channels”, “Move Members” and “Manage Roles” permissions (for permission overwrites).",
    areaSaved: "Party zone updated.",
    areaUnreadable:
      "Settings saved, but I can't read this zone's channels, so their names were not changed.",
    nameDone: (kind: "category" | "join") =>
      kind === "category" ? "the category" : "the join channel",
    nameNotDone: (kind: "category" | "join") =>
      kind === "category" ? "the category" : "the join channel",
    and: " and ",
    renameFailed: (names: string) =>
      `could not rename ${names} (check the “Manage Channels” permission)`,
    renameLimited: (names: string, max: number) =>
      `${names} not renamed: Discord allows ${max} renames per 10 minutes`,
    settingsSaved: (renamed: string | undefined, problems: string) =>
      `Settings saved${renamed ? `, renamed ${renamed}` : ""}, but ${problems}.`,
    areaReady: (joinChannelId: string) =>
      `Party zone ready. Join <#${joinChannelId}> to get your own voice channel.`,
    areaGone: "This zone no longer exists.",
    editNeedsSlash: "Editing a zone needs the slash command: use /party edit.",
    areaChannelsMissing: "I can't read this zone's channels. Check that they were not deleted.",
    areaDeleted: "Party zone deleted.",
    inviteSpecialNeedsSlash:
      "A special invitation needs the slash command: use /party invite-special.",
    notAreaEntrance: "This channel is not the entrance of a party zone.",
    noArea: "There is no party zone on this server.",
    severalAreas: (list: string, purpose: "edit" | "delete") =>
      `There are several zones (${list}). Pick the zone's join channel ${purpose === "edit" ? "to edit" : "to delete"}.`,
    // Names
    templateEmpty: "The name template can't be empty.",
    templateTooLong: (max: number) => `The name template can be at most ${max} characters long.`,
    templateNeedsUser: (placeholder: string, example: string) =>
      `The name template must contain ${placeholder}, e.g. “${example}”.`,
    categoryNameRequired: "Enter a category name.",
    joinNameRequired: "Enter a join channel name.",
    nameTooLong: (max: number) => `The name can be at most ${max} characters long.`,
    // Owner controls
    limitTitle: "User limit",
    limitLabel: "User limit (0 = no limit)",
    limitRange: (max: number) => `The user limit is a number from 0 to ${max}.`,
    renameTitle: "Rename the channel",
    renameLabel: "New name",
    locked: "Channel locked. Only invited people can join.",
    unlocked: "Channel unlocked.",
    hidden: "Channel hidden.",
    shown: "Channel visible again.",
    limitRemoved: "User limit removed.",
    limitSet: (count: number) => `User limit set to ${count}.`,
    nameRequired: "Enter a new channel name.",
    nameInvisible: "The name must contain visible characters.",
    nameUnchanged: (name: string) => `The channel is already named “${name}”.`,
    renameRateLimit: (max: number) => `Discord allows ${max} renames per 10 minutes.`,
    renamed: (name: string) => `Channel renamed to “${name}”.`,
    invited: (userId: string) => `<@${userId}> can join the channel.`,
    cannotBlockOwner: "You can't block the channel's owner.",
    cannotBlockModerator: "You can't block a moderator.",
    blocked: (userId: string) => `<@${userId}> is blocked from the channel.`,
    notInOwnChannel: "You need to be in your own party channel.",
    ownerOnly: "Only the channel's owner can do that.",
    notYourself: "You can't do that to yourself.",
    notOnServer: "There is no such person on this server.",
    notTheBot: "I won't do that to the bot.",
    // Limits
    specialUnavailable: "Special invitations are temporarily unavailable.",
    specialMinute: "You can send a special invitation once a minute. Try again shortly.",
    specialHour: (max: number) => `You can send at most ${max} special invitations per hour.`,
    tooManyChanges: "Too many changes at once. Try again in a moment.",
    // Panel
    panelTitle: "Party channel panel",
    panelDescription:
      "The buttons control your voice channel: join it and pick an action. " +
      "“Special invitation” opens a form with a message and an attachment for the people you pick. " +
      "Only you see the replies, and messages in this chat disappear after 15 seconds.",
    buttonLock: "Lock",
    buttonUnlock: "Unlock",
    buttonHide: "Hide",
    buttonShow: "Show",
    buttonLimit: "Limit",
    buttonRename: "Rename",
    buttonSpecial: "Special invitation",
    selectInvite: "Invite someone…",
    selectBlock: "Block someone…",
    panelOutdated: "This panel is out of date. Ask an administrator for a new one.",
    panelProblem:
      "Could not update the panel in the command channel. Check that the bot can write there and delete messages.",
    // Special invites: form
    specialTitle: "Special invitation",
    specialMembersLabel: `Who to invite (1-${SPECIAL_MAX_MEMBERS} people)`,
    specialTitleLabel: "Title",
    specialTitlePlaceholder: "Default: Party invitation",
    specialMessageLabel: "Message",
    specialMessagePlaceholder: "Default: a short invitation to your channel",
    specialColourLabel: "Colour",
    colourBlue: "Blue",
    colourRed: "Red",
    colourOrange: "Orange",
    colourYellow: "Yellow",
    colourGreen: "Green",
    colourPurple: "Purple",
    colourPink: "Pink",
    colourWhite: "White",
    specialAttachmentLabel: "Attachment",
    specialAttachmentDescription:
      "An image, video or PDF. An image shows in the invitation, anything else arrives as a file.",
    specialOwnerOnly: "Only the channel's owner can send a special invitation.",
    // Special invites: summary for the owner
    skipRecipientLimit: "invitation limit for this person reached",
    skipLimitUnchecked: "could not check the limit",
    skipSelf: "that's you",
    skipMissing: "not on the server",
    skipBot: "that's a bot",
    skipBlocked: "blocked from the channel",
    skipCheckFailed: "could not check",
    skipNoAccess: "could not grant access",
    summaryDelivered: (count: number, mentions: string) =>
      `Invitation delivered (${count}): ${mentions}`,
    summaryDmFailed: (count: number, mentions: string) =>
      `The direct message did not arrive (${count}): ${mentions}. ` +
      "They can still join the channel (the access stays), but they did not get the invitation: let them know yourself.",
    summarySkipped: (count: number, list: string) => `Skipped (${count}): ${list}`,
    summaryAttachmentLost:
      "The attachment could not be downloaded, so the invitations went out without it.",
    // Special invites: the DM
    dmByline: (name: string) => `Invitation from ${name}`,
    dmBylineFrom: (name: string, username: string, guildName: string) =>
      `Invitation from ${name} (@${username}) on ${guildName}`,
    dmTitle: "Party invitation",
    dmDescription: (name: string) => `${name} invites you to their channel.`,
    dmChannelField: "Channel",
    dmChannelFallback: "party channel",
    dmFooter: "The inviter wrote this text, not the bot.",
    dmJoin: "Join",
  },
  de: {
    // /party
    partyDescription: "Party-Zone: Sprachkanäle, die auf Wunsch erstellt werden",
    createDescription:
      "Erstellt eine Kategorie mit einem Kanal, den man betritt, um einen eigenen Sprachkanal zu bekommen",
    createNameOption: "Name der Kategorie",
    editDescription: "Ändert Namen und Einstellungen der Party-Zone in einem Formular",
    deleteDescription: "Löscht die Party-Zone samt ihren Kanälen",
    areaChannelOption: "Beitrittskanal der Zone (wenn es mehrere gibt)",
    lockDescription: "Schließt deinen Kanal für neue Leute",
    unlockDescription: "Öffnet deinen Kanal wieder",
    limitDescription: "Legt das Nutzerlimit für deinen Kanal fest (0 = kein Limit)",
    limitOption: "Nutzerlimit, 0 = kein Limit",
    renameDescription: "Benennt deinen Kanal um",
    renameOption: "Neuer Name",
    inviteDescription:
      "Lässt die gewählte Person in deinen Kanal, auch wenn er geschlossen oder versteckt ist",
    inviteOption: "Wen einladen",
    inviteSpecialDescription:
      "Schickt ein Einladungsformular (Nachricht, Anhang) an ausgewählte Personen",
    blockDescription:
      "Sperrt die gewählte Person aus deinem Kanal aus und wirft sie raus, falls sie drin ist",
    blockOption: "Wen sperren",
    hideDescription: "Versteckt deinen Kanal in der Liste",
    showDescription: "Zeigt deinen Kanal in der Liste",
    // Area form
    areaTitle: "Party-Zone",
    categoryLabel: "Name der Kategorie",
    categoryPlaceholder: "Party",
    joinChannelLabel: "Name des Beitrittskanals",
    templateLabel: "Vorlage für Kanalnamen",
    templateDescription: "{user} wird zum Namen der Person, die beitritt",
    commandChannelLabel: "Befehlskanal",
    commandChannelOn: "An",
    commandChannelOff: "Aus",
    // Names the bot invents
    defaultTemplate: `Kanal von ${USER_PLACEHOLDER}`,
    defaultJoinChannelName: "➕ Beitreten, um einen Kanal zu erstellen",
    fallbackChannelName: "Party-Kanal",
    // Areas
    noGuildPermission:
      "Dafür brauchst du die Berechtigung „Kanäle verwalten“ auf dem ganzen Server, nicht nur in einem Kanal.",
    createFailed:
      "Ich kann die Kanäle nicht erstellen. Prüfe, ob der Bot die Berechtigungen „Kanäle verwalten“, „Mitglieder verschieben“ und „Rollen verwalten“ (für Berechtigungsüberschreibungen) hat.",
    areaSaved: "Party-Zone aktualisiert.",
    areaUnreadable:
      "Einstellungen gespeichert, aber ich kann die Kanäle dieser Zone nicht lesen, deshalb wurden ihre Namen nicht geändert.",
    nameDone: (kind: "category" | "join") => (kind === "category" ? "Kategorie" : "Beitrittskanal"),
    nameNotDone: (kind: "category" | "join") =>
      kind === "category" ? "Kategorie" : "Beitrittskanal",
    and: " und ",
    renameFailed: (names: string) =>
      `die Umbenennung von ${names} ist fehlgeschlagen (prüfe die Berechtigung „Kanäle verwalten“)`,
    renameLimited: (names: string, max: number) =>
      `die Umbenennung von ${names} wurde übersprungen: Discord erlaubt ${max} Umbenennungen pro 10 Minuten`,
    settingsSaved: (renamed: string | undefined, problems: string) =>
      `Einstellungen gespeichert${renamed ? `, umbenannt: ${renamed}` : ""}, aber ${problems}.`,
    areaReady: (joinChannelId: string) =>
      `Party-Zone bereit. Tritt <#${joinChannelId}> bei, um einen eigenen Sprachkanal zu bekommen.`,
    areaGone: "Diese Zone gibt es nicht mehr.",
    editNeedsSlash: "Zum Bearbeiten einer Zone brauchst du den Slash-Befehl: nutze /party edit.",
    areaChannelsMissing:
      "Ich kann die Kanäle dieser Zone nicht lesen. Prüfe, ob sie gelöscht wurden.",
    areaDeleted: "Party-Zone gelöscht.",
    inviteSpecialNeedsSlash:
      "Eine besondere Einladung braucht den Slash-Befehl: nutze /party invite-special.",
    notAreaEntrance: "Dieser Kanal ist kein Beitrittskanal einer Party-Zone.",
    noArea: "Auf diesem Server gibt es keine Party-Zone.",
    severalAreas: (list: string, purpose: "edit" | "delete") =>
      `Es gibt mehrere Zonen (${list}). Gib den Beitrittskanal der Zone an, ${purpose === "edit" ? "die du bearbeiten willst" : "die du löschen willst"}.`,
    // Names
    templateEmpty: "Die Namensvorlage darf nicht leer sein.",
    templateTooLong: (max: number) => `Die Namensvorlage darf höchstens ${max} Zeichen lang sein.`,
    templateNeedsUser: (placeholder: string, example: string) =>
      `Die Namensvorlage muss ${placeholder} enthalten, z. B. „${example}“.`,
    categoryNameRequired: "Gib einen Namen für die Kategorie an.",
    joinNameRequired: "Gib einen Namen für den Beitrittskanal an.",
    nameTooLong: (max: number) => `Der Name darf höchstens ${max} Zeichen lang sein.`,
    // Owner controls
    limitTitle: "Nutzerlimit",
    limitLabel: "Nutzerlimit (0 = kein Limit)",
    limitRange: (max: number) => `Das Nutzerlimit ist eine Zahl von 0 bis ${max}.`,
    renameTitle: "Kanal umbenennen",
    renameLabel: "Neuer Name",
    locked: "Kanal geschlossen. Nur Eingeladene kommen rein.",
    unlocked: "Kanal geöffnet.",
    hidden: "Kanal versteckt.",
    shown: "Kanal wieder sichtbar.",
    limitRemoved: "Nutzerlimit entfernt.",
    limitSet: (count: number) => `Nutzerlimit auf ${count} gesetzt.`,
    nameRequired: "Gib einen neuen Kanalnamen an.",
    nameInvisible: "Der Name muss sichtbare Zeichen enthalten.",
    nameUnchanged: (name: string) => `Der Kanal heißt bereits „${name}“.`,
    renameRateLimit: (max: number) => `Discord erlaubt ${max} Umbenennungen pro 10 Minuten.`,
    renamed: (name: string) => `Kanal in „${name}“ umbenannt.`,
    invited: (userId: string) => `<@${userId}> kann den Kanal betreten.`,
    cannotBlockOwner: "Der Besitzer des Kanals kann nicht gesperrt werden.",
    cannotBlockModerator: "Du kannst keinen Moderator sperren.",
    blocked: (userId: string) => `<@${userId}> ist für den Kanal gesperrt.`,
    notInOwnChannel: "Du musst in deinem eigenen Party-Kanal sein.",
    ownerOnly: "Das kann nur der Besitzer des Kanals tun.",
    notYourself: "Das kannst du dir selbst nicht antun.",
    notOnServer: "Diese Person ist nicht auf diesem Server.",
    notTheBot: "Das mache ich beim Bot nicht.",
    // Limits
    specialUnavailable: "Besondere Einladungen sind vorübergehend nicht verfügbar.",
    specialMinute:
      "Du kannst nur eine besondere Einladung pro Minute senden. Versuche es gleich noch einmal.",
    specialHour: (max: number) =>
      `Du kannst höchstens ${max} besondere Einladungen pro Stunde senden.`,
    tooManyChanges: "Zu viele Änderungen auf einmal. Versuche es gleich noch einmal.",
    // Panel
    panelTitle: "Panel des Party-Kanals",
    panelDescription:
      "Die Buttons steuern deinen Sprachkanal: Tritt ihm bei und wähle eine Aktion. " +
      "„Besondere Einladung“ öffnet ein Formular mit Nachricht und Anhang für ausgewählte Personen. " +
      "Die Antworten siehst nur du, und Nachrichten in diesem Chat verschwinden nach 15 Sekunden.",
    buttonLock: "Schließen",
    buttonUnlock: "Öffnen",
    buttonHide: "Verstecken",
    buttonShow: "Zeigen",
    buttonLimit: "Limit",
    buttonRename: "Umbenennen",
    buttonSpecial: "Besondere Einladung",
    selectInvite: "Person einladen…",
    selectBlock: "Person sperren…",
    panelOutdated: "Dieses Panel ist veraltet. Bitte einen Administrator um ein neues.",
    panelProblem:
      "Das Panel im Befehlskanal konnte nicht aktualisiert werden. Prüfe, ob der Bot dort schreiben und Nachrichten löschen darf.",
    // Special invites: form
    specialTitle: "Besondere Einladung",
    specialMembersLabel: `Wen einladen (1-${SPECIAL_MAX_MEMBERS} Personen)`,
    specialTitleLabel: "Titel",
    specialTitlePlaceholder: "Standard: Einladung zur Party",
    specialMessageLabel: "Nachricht",
    specialMessagePlaceholder: "Standard: eine kurze Einladung in deinen Kanal",
    specialColourLabel: "Farbe",
    colourBlue: "Blau",
    colourRed: "Rot",
    colourOrange: "Orange",
    colourYellow: "Gelb",
    colourGreen: "Grün",
    colourPurple: "Lila",
    colourPink: "Rosa",
    colourWhite: "Weiß",
    specialAttachmentLabel: "Anhang",
    specialAttachmentDescription:
      "Ein Bild, Video oder PDF. Ein Bild erscheint in der Einladung, alles andere kommt als Datei an.",
    specialOwnerOnly: "Nur der Besitzer des Kanals kann eine besondere Einladung senden.",
    // Special invites: summary for the owner
    skipRecipientLimit: "Einladungslimit für diese Person erreicht",
    skipLimitUnchecked: "Limit konnte nicht geprüft werden",
    skipSelf: "das bist du",
    skipMissing: "nicht auf dem Server",
    skipBot: "das ist ein Bot",
    skipBlocked: "für den Kanal gesperrt",
    skipCheckFailed: "konnte nicht geprüft werden",
    skipNoAccess: "Zugriff konnte nicht gewährt werden",
    summaryDelivered: (count: number, mentions: string) =>
      `Einladung zugestellt (${count}): ${mentions}`,
    summaryDmFailed: (count: number, mentions: string) =>
      `Die Direktnachricht ist nicht angekommen (${count}): ${mentions}. ` +
      "Sie können den Kanal trotzdem betreten (der Zugriff bleibt), haben die Einladung aber nicht bekommen: Sag ihnen selbst Bescheid.",
    summarySkipped: (count: number, list: string) => `Übersprungen (${count}): ${list}`,
    summaryAttachmentLost:
      "Der Anhang konnte nicht heruntergeladen werden, die Einladungen gingen ohne ihn raus.",
    // Special invites: the DM
    dmByline: (name: string) => `Einladung von ${name}`,
    dmBylineFrom: (name: string, username: string, guildName: string) =>
      `Einladung von ${name} (@${username}) vom Server ${guildName}`,
    dmTitle: "Einladung zur Party",
    dmDescription: (name: string) => `${name} hat dich in einen Party-Kanal eingeladen.`,
    dmChannelField: "Kanal",
    dmChannelFallback: "Party-Kanal",
    dmFooter: "Den Text hat der Einladende geschrieben, nicht der Bot.",
    dmJoin: "Beitreten",
  },
});
