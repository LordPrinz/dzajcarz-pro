import { describe, expect, test } from "bun:test";
import { ActivityType, type Client } from "discord.js";
import { createPresence } from "./presence.ts";

function clientRecording() {
  const activities: unknown[] = [];
  const client = { user: { setActivity: (activity: unknown) => activities.push(activity) } };
  return { activities, client: client as unknown as Client };
}

describe("presence adapter", () => {
  test("a regular activity shows its text as the name", () => {
    const { activities, client } = clientRecording();
    createPresence(client).setActivity({ type: "listening", text: "Lato z Radiem" });
    expect(activities).toEqual([{ type: ActivityType.Listening, name: "Lato z Radiem" }]);
  });

  test("a custom status puts the text into state, where Discord shows it", () => {
    const { activities, client } = clientRecording();
    createPresence(client).setActivity({ type: "custom", text: "Śpię" });
    expect(activities).toEqual([{ type: ActivityType.Custom, name: "custom", state: "Śpię" }]);
  });

  test("before login there is no user and nothing happens", () => {
    expect(() =>
      createPresence({ user: null } as unknown as Client).setActivity({
        type: "playing",
        text: "x",
      }),
    ).not.toThrow();
  });
});
