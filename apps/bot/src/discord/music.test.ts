import { describe, expect, test } from "bun:test";
import { type Client, RESTJSONErrorCodes } from "discord.js";
import { createPanelMessages, createVoiceChannels } from "./music.ts";

const GUILD = "100000000000000001";
const VOICE = "400000000000000004";
const TEXT = "300000000000000003";

function voiceClient() {
  const members = new Map([
    ["1", { user: { bot: false } }],
    ["2", { user: { bot: true } }],
    ["3", { user: { bot: false } }],
  ]);
  const channel = {
    isVoiceBased: () => true,
    members: {
      filter: (keep: (m: { user: { bot: boolean } }) => boolean) => ({
        size: [...members.values()].filter(keep).length,
      }),
    },
  };
  const guild = {
    voiceStates: { cache: new Map([["1", { channelId: VOICE }]]) },
    channels: { cache: new Map([[VOICE, channel]]) },
  };
  return { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
}

describe("createVoiceChannels", () => {
  test("reads the member's channel and counts people without bots", async () => {
    const voice = createVoiceChannels(voiceClient());
    expect(await voice.channelOf(GUILD, "1")).toBe(VOICE);
    expect(await voice.channelOf(GUILD, "9")).toBeNull();
    expect(await voice.channelOf("unknown", "1")).toBeNull();
    expect(await voice.humanCount(GUILD, VOICE)).toBe(2);
    expect(await voice.humanCount(GUILD, "missing")).toBe(0);
  });
});

function textClient(deleteError?: unknown) {
  const sent: unknown[] = [];
  const edited: unknown[] = [];
  const channel = {
    isSendable: () => true,
    send: async (payload: unknown) => {
      sent.push(payload);
      return { id: "500000000000000005" };
    },
    messages: {
      edit: async (id: string, payload: unknown) => void edited.push({ id, payload }),
      delete: async () => {
        if (deleteError) throw deleteError;
      },
    },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  return { client, sent, edited };
}

describe("createPanelMessages", () => {
  test("posts and edits without mentions", async () => {
    const { client, sent, edited } = textClient();
    const panels = createPanelMessages(client);
    expect(await panels.post(TEXT, { embeds: [{ title: "Song" }] })).toBe("500000000000000005");
    expect(sent[0]).toMatchObject({ embeds: [{ title: "Song" }], allowedMentions: { parse: [] } });
    await panels.edit(TEXT, "5", { embeds: [{ title: "Next" }] });
    expect(edited[0]).toMatchObject({
      id: "5",
      payload: { content: null, embeds: [{ title: "Next" }] },
    });
  });

  test("a panel that is already gone counts as deleted", async () => {
    const gone = createPanelMessages(
      textClient({ code: RESTJSONErrorCodes.UnknownMessage }).client,
    );
    await gone.delete(TEXT, "5");
    const refused = createPanelMessages(
      textClient({ code: RESTJSONErrorCodes.MissingPermissions }).client,
    );
    await expect(refused.delete(TEXT, "5")).rejects.toMatchObject({ code: 50013 });
  });
});
