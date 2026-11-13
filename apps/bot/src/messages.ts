import { defineMessages } from "@dzajcarz/core";

/** What the bot's own adapters say to members. */
export const t = defineMessages({
  pl: {
    moduleDisabled: "Ten moduł jest wyłączony na tym serwerze albo kanale.",
    botMissingPermissions:
      "Nie mam uprawnień, żeby to zrobić. Sprawdź moje uprawnienia i czy moja rola jest wyżej.",
    memberGone: "Tej osoby nie ma na serwerze.",
    unknownUser: "Nie ma takiego użytkownika.",
    notATextChannel: "Tu nie mogę usuwać wiadomości.",
  },
  en: {
    moduleDisabled: "This module is turned off on this server or in this channel.",
    botMissingPermissions:
      "I don't have permission to do that. Check my permissions and that my role is high enough.",
    memberGone: "That person isn't on the server.",
    unknownUser: "There is no such user.",
    notATextChannel: "I can't delete messages here.",
  },
  de: {
    moduleDisabled: "Dieses Modul ist auf diesem Server oder in diesem Kanal ausgeschaltet.",
    botMissingPermissions:
      "Dafür fehlen mir die Berechtigungen. Prüf meine Berechtigungen und ob meine Rolle hoch genug ist.",
    memberGone: "Diese Person ist nicht auf dem Server.",
    unknownUser: "Diesen Nutzer gibt es nicht.",
    notATextChannel: "Hier kann ich keine Nachrichten löschen.",
  },
});
