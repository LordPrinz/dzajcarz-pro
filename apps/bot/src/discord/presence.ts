import type { Clock, Presence } from "@dzajcarz/module-status";
import { ActivityType, type Client } from "discord.js";

const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
} as const;

export function createPresence(client: Client): Presence {
  return {
    setActivity: ({ type, text }) => {
      // Custom activities show `state`; the name is only a label for them.
      client.user?.setActivity(
        type === "custom"
          ? { type: ACTIVITY_TYPES[type], name: "custom", state: text }
          : { type: ACTIVITY_TYPES[type], name: text },
      );
    },
  };
}

export function createClock(): Clock {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}
