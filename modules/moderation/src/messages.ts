import { defineMessages, plural } from "@dzajcarz/core";
import { MAX_PURGE, MAX_REASON_LENGTH } from "./limits.ts";

const plWarnings = (total: number) =>
  `${total} ${plural(total, "ostrzeżenie", "ostrzeżenia", "ostrzeżeń")}`;
const enWarnings = (total: number) => `${total} ${total === 1 ? "warning" : "warnings"}`;
const deWarnings = (total: number) => `${total} ${total === 1 ? "Verwarnung" : "Verwarnungen"}`;

/** Every member-facing text of the moderation module. */
export const t = defineMessages({
  pl: {
    banDescription: "Banuje osobę na serwerze (także kogoś, kogo już tu nie ma)",
    banUser: "Kogo zbanować",
    kickDescription: "Wyrzuca osobę z serwera",
    kickUser: "Kogo wyrzucić",
    timeoutDescription: "Wycisza osobę na podany czas (najwyżej 28 dni)",
    timeoutUser: "Kogo wyciszyć",
    timeoutDuration: "Na ile: 30s, 10m, 2h albo 1d",
    untimeoutDescription: "Zdejmuje wyciszenie przed czasem",
    untimeoutUser: "Komu zdjąć wyciszenie",
    warnDescription: "Daje osobie ostrzeżenie, zapisane w historii",
    warnUser: "Kogo ostrzec",
    warningsDescription: "Pokazuje ostrzeżenia osoby",
    warningsUser: "Czyje ostrzeżenia pokazać",
    purgeDescription: `Usuwa ostatnie wiadomości na tym kanale (do ${MAX_PURGE}, młodsze niż 14 dni)`,
    purgeCount: "Ile wiadomości usunąć",
    reasonOption: `Powód (do ${MAX_REASON_LENGTH} znaków)`,

    noReason: "brak powodu",
    because: (reason: string) => `Powód: ${reason}`,
    notRecorded: " (nie udało się zapisać w historii)",

    notAMember: "Tej osoby nie ma na serwerze.",
    botLacksPermission: "Nie mam uprawnień, żeby to zrobić. Sprawdź moje uprawnienia na serwerze.",
    adminTimeout: "Nie można wyciszyć administratora.",
    reasonTooLong: `Powód może mieć najwyżej ${MAX_REASON_LENGTH} znaków.`,
    badDuration: "Podaj czas jak 30s, 10m, 2h albo 1d (najwyżej 28d).",
    notTimedOut: "Ta osoba nie jest wyciszona.",
    badPurgeCount: (max: number) => `Podaj liczbę od 1 do ${max}.`,

    selfTarget: "Nie możesz moderować samego siebie.",
    botTarget: "Nie mogę moderować samego siebie.",
    ownerTarget: "Nie można moderować właściciela serwera.",
    higherThanActor: "Ta osoba ma rolę równą Twojej albo wyższą.",
    higherThanBot: "Moja rola jest za nisko, żeby moderować tę osobę.",

    banDm: (guild: string, because: string) => `Ban na serwerze ${guild}. ${because}`,
    banFailedDm: (guild: string) => `Ban na serwerze ${guild} nie doszedł do skutku.`,
    kickDm: (guild: string, because: string) => `Wyrzucenie z serwera ${guild}. ${because}`,
    kickFailedDm: (guild: string) => `Wyrzucenie z serwera ${guild} nie doszło do skutku.`,
    timeoutDm: (guild: string, length: string, because: string) =>
      `Wyciszenie na serwerze ${guild} na ${length}. ${because}`,
    warnDm: (guild: string, because: string) => `Ostrzeżenie na serwerze ${guild}. ${because}`,

    banned: (id: string, because: string) => `Zbanowano <@${id}>. ${because}`,
    kicked: (id: string, because: string) => `Wyrzucono <@${id}>. ${because}`,
    timedOut: (id: string, length: string, because: string) =>
      `Wyciszono <@${id}> na ${length}. ${because}`,
    untimedOut: (id: string, because: string) => `Zdjęto wyciszenie z <@${id}>. ${because}`,
    /** `count` is the member's warning total, null when it could not be counted. */
    warned: (id: string, count: number | null, because: string) =>
      `Ostrzeżenie dla <@${id}>${count === null ? "" : ` (ostrzeżenie nr ${count})`}. ${because}`,

    noWarnings: (id: string) => `<@${id}> nie ma ostrzeżeń.`,
    warningsHeader: (id: string, total: number) => `<@${id}> ma ${plWarnings(total)}:`,
    warningsHeaderCut: (id: string, total: number, shown: number) =>
      `<@${id}> ma ${plWarnings(total)}, ${shown} najnowszych:`,
    warningsHeaderOnly: (id: string, total: number) => `<@${id}> ma ${plWarnings(total)}.`,
    warningLine: (id: number, date: string, moderatorId: string, reason: string) =>
      `\`#${id}\` ${date} od <@${moderatorId}>: ${reason}`,
    warningsSent: "Wysłałem Ci listę w prywatnej wiadomości.",
    warningsDmClosed: "Nie mogę wysłać Ci prywatnej wiadomości. Użyj /warnings.",

    purged: (n: number) => `Usunięto ${n} ${plural(n, "wiadomość", "wiadomości", "wiadomości")}.`,
    skippedOld: (n: number) =>
      `Pominięto ${n} ${plural(n, "starszą", "starsze", "starszych")} niż 14 dni.`,
    skippedPinned: (n: number) =>
      `Pominięto ${n} ${plural(n, "przypiętą", "przypięte", "przypiętych")}.`,
  },
  en: {
    banDescription: "Bans a person from the server (even someone who is no longer here)",
    banUser: "Who to ban",
    kickDescription: "Kicks a person from the server",
    kickUser: "Who to kick",
    timeoutDescription: "Times a person out for the given time (28 days at most)",
    timeoutUser: "Who to time out",
    timeoutDuration: "For how long: 30s, 10m, 2h or 1d",
    untimeoutDescription: "Ends a timeout early",
    untimeoutUser: "Whose timeout to end",
    warnDescription: "Gives a person a warning, saved in the history",
    warnUser: "Who to warn",
    warningsDescription: "Shows a person's warnings",
    warningsUser: "Whose warnings to show",
    purgeDescription: `Deletes the latest messages in this channel (up to ${MAX_PURGE}, newer than 14 days)`,
    purgeCount: "How many messages to delete",
    reasonOption: `Reason (up to ${MAX_REASON_LENGTH} characters)`,

    noReason: "no reason given",
    because: (reason) => `Reason: ${reason}`,
    notRecorded: " (could not be saved to the history)",

    notAMember: "That person is not on the server.",
    botLacksPermission:
      "I don't have the permissions to do that. Check my permissions on the server.",
    adminTimeout: "An administrator cannot be timed out.",
    reasonTooLong: `The reason can be at most ${MAX_REASON_LENGTH} characters long.`,
    badDuration: "Give a time like 30s, 10m, 2h or 1d (28d at most).",
    notTimedOut: "That person is not timed out.",
    badPurgeCount: (max) => `Give a number from 1 to ${max}.`,

    selfTarget: "You can't moderate yourself.",
    botTarget: "I can't moderate myself.",
    ownerTarget: "The server owner can't be moderated.",
    higherThanActor: "That person has a role equal to or higher than yours.",
    higherThanBot: "My role is too low to moderate that person.",

    banDm: (guild, because) => `You were banned from ${guild}. ${because}`,
    banFailedDm: (guild) => `The ban from ${guild} did not go through.`,
    kickDm: (guild, because) => `You were kicked from ${guild}. ${because}`,
    kickFailedDm: (guild) => `The kick from ${guild} did not go through.`,
    timeoutDm: (guild, length, because) =>
      `You were timed out on ${guild} for ${length}. ${because}`,
    warnDm: (guild, because) => `You received a warning on ${guild}. ${because}`,

    banned: (id, because) => `Banned <@${id}>. ${because}`,
    kicked: (id, because) => `Kicked <@${id}>. ${because}`,
    timedOut: (id, length, because) => `Timed out <@${id}> for ${length}. ${because}`,
    untimedOut: (id, because) => `Ended the timeout of <@${id}>. ${because}`,
    warned: (id, count, because) =>
      `Warning for <@${id}>${count === null ? "" : ` (warning #${count})`}. ${because}`,

    noWarnings: (id) => `<@${id}> has no warnings.`,
    warningsHeader: (id, total) => `<@${id}> has ${enWarnings(total)}:`,
    warningsHeaderCut: (id, total, shown) =>
      `<@${id}> has ${enWarnings(total)}, the ${shown} most recent:`,
    warningsHeaderOnly: (id, total) => `<@${id}> has ${enWarnings(total)}.`,
    warningLine: (id, date, moderatorId, reason) =>
      `\`#${id}\` ${date} by <@${moderatorId}>: ${reason}`,
    warningsSent: "I sent you the list in a private message.",
    warningsDmClosed: "I can't send you a private message. Use /warnings.",

    purged: (n) => `Deleted ${n} ${n === 1 ? "message" : "messages"}.`,
    skippedOld: (n) => `Skipped ${n} ${n === 1 ? "message" : "messages"} older than 14 days.`,
    skippedPinned: (n) => `Skipped ${n} pinned ${n === 1 ? "message" : "messages"}.`,
  },
  de: {
    banDescription: "Bannt eine Person vom Server (auch jemanden, der nicht mehr hier ist)",
    banUser: "Wen bannen",
    kickDescription: "Wirft eine Person vom Server",
    kickUser: "Wen rauswerfen",
    timeoutDescription: "Schaltet eine Person für die angegebene Zeit stumm (höchstens 28 Tage)",
    timeoutUser: "Wen stummschalten",
    timeoutDuration: "Wie lange: 30s, 10m, 2h oder 1d",
    untimeoutDescription: "Hebt eine Stummschaltung vorzeitig auf",
    untimeoutUser: "Wessen Stummschaltung aufheben",
    warnDescription: "Verwarnt eine Person, gespeichert im Verlauf",
    warnUser: "Wen verwarnen",
    warningsDescription: "Zeigt die Verwarnungen einer Person",
    warningsUser: "Wessen Verwarnungen anzeigen",
    purgeDescription: `Löscht die letzten Nachrichten in diesem Kanal (bis zu ${MAX_PURGE}, jünger als 14 Tage)`,
    purgeCount: "Wie viele Nachrichten löschen",
    reasonOption: `Grund (bis zu ${MAX_REASON_LENGTH} Zeichen)`,

    noReason: "kein Grund angegeben",
    because: (reason) => `Grund: ${reason}`,
    notRecorded: " (konnte nicht im Verlauf gespeichert werden)",

    notAMember: "Diese Person ist nicht auf dem Server.",
    botLacksPermission:
      "Ich habe nicht die Berechtigung dafür. Prüf meine Berechtigungen auf dem Server.",
    adminTimeout: "Ein Administrator kann nicht stummgeschaltet werden.",
    reasonTooLong: `Der Grund darf höchstens ${MAX_REASON_LENGTH} Zeichen lang sein.`,
    badDuration: "Gib eine Zeit wie 30s, 10m, 2h oder 1d an (höchstens 28d).",
    notTimedOut: "Diese Person ist nicht stummgeschaltet.",
    badPurgeCount: (max) => `Gib eine Zahl von 1 bis ${max} an.`,

    selfTarget: "Du kannst dich nicht selbst moderieren.",
    botTarget: "Ich kann mich nicht selbst moderieren.",
    ownerTarget: "Der Servereigentümer kann nicht moderiert werden.",
    higherThanActor: "Diese Person hat eine Rolle, die gleich oder höher als deine ist.",
    higherThanBot: "Meine Rolle ist zu niedrig, um diese Person zu moderieren.",

    banDm: (guild, because) => `Du wurdest von ${guild} gebannt. ${because}`,
    banFailedDm: (guild) => `Der Bann von ${guild} ist nicht zustande gekommen.`,
    kickDm: (guild, because) => `Du wurdest von ${guild} geworfen. ${because}`,
    kickFailedDm: (guild) => `Der Rauswurf von ${guild} ist nicht zustande gekommen.`,
    timeoutDm: (guild, length, because) =>
      `Du wurdest auf ${guild} für ${length} stummgeschaltet. ${because}`,
    warnDm: (guild, because) => `Du hast auf ${guild} eine Verwarnung erhalten. ${because}`,

    banned: (id, because) => `<@${id}> wurde gebannt. ${because}`,
    kicked: (id, because) => `<@${id}> wurde rausgeworfen. ${because}`,
    timedOut: (id, length, because) => `<@${id}> wurde für ${length} stummgeschaltet. ${because}`,
    untimedOut: (id, because) => `Die Stummschaltung von <@${id}> wurde aufgehoben. ${because}`,
    warned: (id, count, because) =>
      `Verwarnung für <@${id}>${count === null ? "" : ` (Verwarnung Nr. ${count})`}. ${because}`,

    noWarnings: (id) => `<@${id}> hat keine Verwarnungen.`,
    warningsHeader: (id, total) => `<@${id}> hat ${deWarnings(total)}:`,
    warningsHeaderCut: (id, total, shown) =>
      `<@${id}> hat ${deWarnings(total)}, die ${shown} neuesten:`,
    warningsHeaderOnly: (id, total) => `<@${id}> hat ${deWarnings(total)}.`,
    warningLine: (id, date, moderatorId, reason) =>
      `\`#${id}\` ${date} von <@${moderatorId}>: ${reason}`,
    warningsSent: "Ich habe dir die Liste in einer privaten Nachricht geschickt.",
    warningsDmClosed: "Ich kann dir keine private Nachricht schicken. Nutze /warnings.",

    purged: (n) => `${n} ${n === 1 ? "Nachricht" : "Nachrichten"} gelöscht.`,
    skippedOld: (n) =>
      `${n} ${n === 1 ? "Nachricht" : "Nachrichten"} übersprungen, älter als 14 Tage.`,
    skippedPinned: (n) => `${n} angeheftete ${n === 1 ? "Nachricht" : "Nachrichten"} übersprungen.`,
  },
});
