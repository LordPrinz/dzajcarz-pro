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

export const DEFAULT_ACTIVITIES: readonly Activity[] = [
  { type: "playing", text: "Ein Heller und ein Batzen" },
  { type: "listening", text: "HEILI HEILO HEILA" },
  { type: "watching", text: "jak Heller ward zu Wasser" },
  { type: "competing", text: "w piciu piwa" },
  { type: "custom", text: "Batzen ward zu Wein" },
];

export const DEFAULT_INTERVAL_MS = 60_000;

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
