import { defineMessages } from "@dzajcarz/core";

/** Every member-facing text of the fun module. */
export const t = defineMessages({
  pl: {
    didYouKnowDescription: "Odpowiada na odwieczne pytanie",
    knew: "Wiedział!",
    didNotKnow: "Nie wiedział sadge bruh",
    timeDescription: "Aktualny czas w strefie czasowej serwera",
    timeNow: (clock: string) => `Jest ${clock}.`,
  },
  en: {
    didYouKnowDescription: "Answers the age-old question",
    knew: "He knew!",
    didNotKnow: "He didn't know sadge bruh",
    timeDescription: "The current time in the server's time zone",
    timeNow: (clock: string) => `It is ${clock}.`,
  },
  de: {
    didYouKnowDescription: "Beantwortet die uralte Frage",
    knew: "Er wusste es!",
    didNotKnow: "Er wusste es nicht, sadge bruh",
    timeDescription: "Die aktuelle Uhrzeit in der Zeitzone des Servers",
    timeNow: (clock: string) => `Es ist ${clock}.`,
  },
});
