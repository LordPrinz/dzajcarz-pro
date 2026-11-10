import { describe, expect, test } from "bun:test";
import { createModuleEnabled, eventScope } from "./event-scope.ts";

describe("eventScope", () => {
  test("messageCreate uses the message's guild and channel; DMs are not gated", () => {
    expect(eventScope("messageCreate", [{ guildId: "g", channelId: "c" }])).toEqual({
      guildId: "g",
      channelId: "c",
    });
    expect(eventScope("messageCreate", [{ guildId: null, channelId: "dm" }])).toBeNull();
  });

  test("a message in a thread is scoped to the parent channel", () => {
    const channel = { isThread: () => true, parentId: "parent" };
    expect(eventScope("messageCreate", [{ guildId: "g", channelId: "thread", channel }])).toEqual({
      guildId: "g",
      channelId: "parent",
    });
    const plain = { isThread: () => false, parentId: null };
    expect(
      eventScope("messageCreate", [{ guildId: "g", channelId: "c", channel: plain }])?.channelId,
    ).toBe("c");
  });

  test("an interaction in a thread is scoped to the parent channel", () => {
    const channel = { isThread: () => true, parentId: "parent" };
    expect(
      eventScope("interactionCreate", [{ guildId: "g", channelId: "thread", channel }]),
    ).toEqual({ guildId: "g", channelId: "parent" });
  });

  test("messageDelete and messageDeleteBulk use the channel of the deleted messages", () => {
    expect(eventScope("messageDelete", [{ guildId: "g", channelId: "c" }])).toEqual({
      guildId: "g",
      channelId: "c",
    });
    expect(eventScope("messageDelete", [{ guildId: null, channelId: "dm" }])).toBeNull();
    expect(eventScope("messageDeleteBulk", [new Map(), { guildId: "g", id: "c" }])).toEqual({
      guildId: "g",
      channelId: "c",
    });
  });

  test("guildMemberAdd is guild-wide", () => {
    expect(eventScope("guildMemberAdd", [{ guild: { id: "g" } }])).toEqual({
      guildId: "g",
      channelId: null,
    });
  });

  test("voiceStateUpdate prefers the new channel and falls back to the old one on leave", () => {
    const state = (channelId: string | null) => ({ guild: { id: "g" }, channelId });
    expect(eventScope("voiceStateUpdate", [state("old"), state("new")])?.channelId).toBe("new");
    expect(eventScope("voiceStateUpdate", [state("old"), state(null)])?.channelId).toBe("old");
    expect(eventScope("voiceStateUpdate", [state(null), state(null)])?.channelId).toBeNull();
  });

  test("channelDelete uses the deleted channel; a DM channel is not gated", () => {
    expect(eventScope("channelDelete", [{ guildId: "g", id: "c" }])).toEqual({
      guildId: "g",
      channelId: "c",
    });
    expect(eventScope("channelDelete", [{ id: "dm" }])).toBeNull();
  });

  test("interactionCreate uses the interaction's guild and channel", () => {
    expect(eventScope("interactionCreate", [{ guildId: "g", channelId: "c" }])).toEqual({
      guildId: "g",
      channelId: "c",
    });
    expect(eventScope("interactionCreate", [{ guildId: null, channelId: "dm" }])).toBeNull();
  });

  test("unknown events are not gated", () => {
    expect(eventScope("ready", [{}])).toBeNull();
    expect(eventScope("guildCreate", [{ id: "g" }])).toBeNull();
  });
});

describe("createModuleEnabled", () => {
  test("asks the gate about the parent channel of a thread and about a plain channel as is", async () => {
    const asked: string[][] = [];
    const channels = new Map([
      ["thread", { isThread: () => true, parentId: "parent" }],
      ["text", { isThread: () => false, parentId: null }],
    ]);
    const enabled = createModuleEnabled(
      {
        isEnabled: async (guildId, channelId, module) => {
          asked.push([guildId, channelId, module]);
          return true;
        },
      },
      channels,
    );
    await enabled("g", "thread", "music");
    await enabled("g", "text", "music");
    await enabled("g", "uncached", "music");
    expect(asked).toEqual([
      ["g", "parent", "music"],
      ["g", "text", "music"],
      ["g", "uncached", "music"],
    ]);
  });
});
