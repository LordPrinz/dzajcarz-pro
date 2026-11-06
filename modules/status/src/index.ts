import { type BotModule, defineEvent, type Logger } from "@dzajcarz/core";

export type ActivityType = "playing" | "listening" | "watching" | "competing" | "custom";

export interface Activity {
  type: ActivityType;
  text: string;
}

export interface Presence {
  /** Sets the bot's single activity. May throw (e.g. the gateway is not ready yet). */
  setActivity(activity: Activity): void;
}

export interface Clock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StatusModuleDeps {
  presence: Presence;
  clock: Clock;
  logger: Logger;
  activities?: readonly Activity[];
  intervalMs?: number;
}

/** The old bot's status: "Ein Heller und ein Batzen" (German folk song), one phrase at a time. */
const SONG = [
  "Ein Heller",
  "und",
  "ein Batzen",
  "Die waren",
  "beide mein",
  "ja mein",
  "Der Heller",
  "ward zu Wasser",
  "Der Batzen",
  "ward zu Wein",
  "ja Wein",
  "Der Helle",
  "ward zu Wasser",
  "Der Batzen",
  "ward zu Wein",
  "HEILI",
  "HEILO",
  "HEILA",
  "HEILI",
  "HEILO",
  "HEILA",
  "HEILI",
  "HEILO",
  "HEILA",
  "HA HA HA HA HA HA HA",
  "HEILI",
  "HEILO",
  "HEILA",
  "HEILI",
  "HEILO",
  "HEILA",
  "HEILI",
  "HEILO",
  "HEILA",
];

export const DEFAULT_ACTIVITIES: readonly Activity[] = SONG.map((text) => ({
  type: "playing",
  text,
}));

export const DEFAULT_INTERVAL_MS = 15_000;

export function createStatusModule({
  presence,
  clock,
  logger,
  activities = DEFAULT_ACTIVITIES,
  intervalMs = DEFAULT_INTERVAL_MS,
}: StatusModuleDeps): BotModule {
  if (activities.length === 0) throw new Error("The status module needs at least one activity");
  if (!(intervalMs > 0)) throw new Error("The status interval must be a positive number of ms");

  let handle: unknown;
  let started = false;
  let index = 0;

  function showNext(): void {
    const activity = activities[index];
    index = (index + 1) % activities.length;
    if (!activity) return;
    try {
      presence.setActivity(activity);
    } catch (error) {
      logger.warn("Setting the bot activity failed", { activity, error });
    }
  }

  const start = defineEvent({
    name: "status-start",
    event: "clientReady",
    once: true,
    // A status is not a feature of a guild, so toggling the module off per guild must not freeze it.
    alwaysRun: true,
    run: () => {
      if (started) return;
      started = true;
      showNext();
      handle = clock.setInterval(showNext, intervalMs);
    },
  });

  return {
    name: "status",
    events: [start],
    dispose: () => {
      if (!started) return;
      clock.clearInterval(handle);
      handle = undefined;
    },
  };
}
