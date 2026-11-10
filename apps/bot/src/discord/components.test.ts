import { describe, expect, test } from "bun:test";
import type { ResolvedComponent } from "@dzajcarz/core";
import { defineButton } from "@dzajcarz/core";
import {
  type ButtonInteraction,
  ButtonStyle,
  ComponentType,
  type Message,
  MessageFlags,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { contextFromComponent } from "./component-context.ts";
import { toComponentRows } from "./components.ts";
import { contextFromMessage } from "./context.ts";
import { toReplyPayload } from "./reply.ts";

describe("toComponentRows", () => {
  test("maps buttons, link buttons and selects to Discord JSON", () => {
    const rows = toComponentRows([
      [
        { type: "button", customId: "a:b:1:", label: "OK", style: "success", emoji: "✅" },
        { type: "link", url: "https://discord.com", label: "Dodaj", disabled: true },
      ],
      [
        {
          type: "select",
          customId: "a:s:1:",
          placeholder: "Wybierz",
          options: [{ label: "A", value: "a", default: true, emoji: "🎵" }],
        },
      ],
    ]);
    expect(rows[0]).toEqual({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          custom_id: "a:b:1:",
          label: "OK",
          emoji: { name: "✅" },
          disabled: undefined,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          url: "https://discord.com",
          label: "Dodaj",
          emoji: undefined,
          disabled: true,
        },
      ],
    });
    expect(rows[1]?.components[0]).toMatchObject({
      type: ComponentType.StringSelect,
      custom_id: "a:s:1:",
      placeholder: "Wybierz",
      options: [{ label: "A", value: "a", default: true, emoji: { name: "🎵" } }],
    });
  });

  test("maps a user select to Discord's user select menu", () => {
    const [row] = toComponentRows([
      [{ type: "user-select", customId: "a:u:1:", placeholder: "Kogo?" }],
    ]);
    expect(row).toEqual({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.UserSelect,
          custom_id: "a:u:1:",
          placeholder: "Kogo?",
          min_values: 1,
          max_values: 1,
          disabled: undefined,
        },
      ],
    });
  });

  test("buttons default to the secondary style", () => {
    const [row] = toComponentRows([[{ type: "button", customId: "x", label: "x" }]]);
    expect(row?.components[0]).toMatchObject({ style: ButtonStyle.Secondary });
  });

  test("refuses rows that break a Discord limit", () => {
    expect(() => toComponentRows([[]])).toThrow("empty");
  });

  test("reply payloads carry the components", () => {
    const payload = toReplyPayload({
      content: "x",
      components: [[{ type: "button", customId: "x", label: "x" }]],
    });
    expect(payload.components).toHaveLength(1);
    expect(toReplyPayload("x").components).toEqual([]);
  });

  test("embeds keep the title link and the thumbnail", () => {
    const [embed] = toReplyPayload({
      embeds: [
        { title: "Song", url: "https://example.com/a", thumbnail: "https://example.com/a.jpg" },
      ],
    }).embeds;
    expect(embed?.url).toBe("https://example.com/a");
    expect(embed?.thumbnail).toEqual({ url: "https://example.com/a.jpg" });
    expect(toReplyPayload({ embeds: [{ title: "x" }] }).embeds[0]?.thumbnail).toBeUndefined();
  });
});

function fakeClick(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; payload: unknown }[] = [];
  const record = (method: string) => async (payload: unknown) => {
    calls.push({ method, payload });
  };
  const interaction = {
    user: { id: "1", displayName: "tester" },
    guildId: "10",
    channelId: "20",
    inGuild: () => true,
    memberPermissions: { bitfield: 8n },
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    message: { id: "msg1" },
    update: record("update"),
    deferUpdate: record("deferUpdate"),
    reply: record("reply"),
    editReply: record("editReply"),
    followUp: record("followUp"),
    webhook: {
      editMessage: async (id: string, payload: unknown) =>
        void calls.push({ method: `editMessage:${id}`, payload }),
    },
    ...overrides,
  };
  return { interaction, calls };
}

const resolved: ResolvedComponent = {
  component: defineButton({ module: "m", name: "n", run: async () => {} }),
  module: "m",
  owner: "1",
  state: "s",
};

describe("contextFromComponent", () => {
  test("exposes the clicking member, guild, permissions and state", () => {
    const { interaction } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    expect(ctx).toMatchObject({
      state: "s",
      values: [],
      guildId: "10",
      channelId: "20",
      memberPermissions: 8n,
    });
    expect(ctx.user).toEqual({ id: "1", displayName: "tester" });
  });

  test("passes the chosen values of a select menu", () => {
    const { interaction } = fakeClick({ isStringSelectMenu: () => true, values: ["a", "b"] });
    const ctx = contextFromComponent(
      interaction as unknown as StringSelectMenuInteraction,
      resolved,
    );
    expect(ctx.values).toEqual(["a", "b"]);
  });

  test("passes the chosen user of a user select menu", () => {
    const { interaction } = fakeClick({ isUserSelectMenu: () => true, values: ["42"] });
    const ctx = contextFromComponent(interaction as unknown as UserSelectMenuInteraction, resolved);
    expect(ctx.values).toEqual(["42"]);
  });

  test("has no permissions outside a guild", () => {
    const { interaction } = fakeClick({ guildId: null, inGuild: () => false });
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    expect(ctx.memberPermissions).toBeNull();
  });

  test("update edits the clicked message, with mentions disabled", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    await ctx.update({ content: "new", components: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "update",
      payload: { content: "new", components: [], allowedMentions: { parse: [] } },
    });
  });

  test("a second update goes through editReply", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    await ctx.update("one");
    await ctx.update("again");
    expect(calls.map((c) => c.method)).toEqual(["update", "editReply"]);
  });

  test("update after reply edits the clicked message, not the ephemeral reply", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    await ctx.reply("psst");
    await ctx.update("new");
    expect(calls.map((c) => c.method)).toEqual(["reply", "editMessage:msg1"]);
    expect(calls[1]?.payload).toMatchObject({ content: "new", allowedMentions: { parse: [] } });
  });

  test("defer acknowledges the click and a later update goes through editReply", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    expect(ctx.acknowledged).toBe(false);
    await ctx.defer();
    expect(ctx.acknowledged).toBe(true);
    await ctx.defer();
    await ctx.update("done");
    expect(calls.map((c) => c.method)).toEqual(["deferUpdate", "editReply"]);
  });

  test("acknowledged turns true after update and after reply", async () => {
    for (const act of ["update", "reply"] as const) {
      const { interaction } = fakeClick();
      const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
      await ctx[act]("x");
      expect(ctx.acknowledged).toBe(true);
    }
  });

  test("an explicit ephemeral: undefined still replies ephemerally", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    await ctx.reply({ content: "x", ephemeral: undefined });
    expect(calls[0]).toMatchObject({ method: "reply", payload: { flags: MessageFlags.Ephemeral } });
  });

  test("reply is ephemeral by default and can opt out", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    await ctx.reply("psst");
    await ctx.reply({ content: "all", ephemeral: false });
    expect(calls[0]).toMatchObject({ method: "reply", payload: { flags: MessageFlags.Ephemeral } });
    expect(calls[1]?.payload).not.toHaveProperty("flags", MessageFlags.Ephemeral);
  });

  test("reply after an answer becomes a follow-up", async () => {
    const { interaction, calls } = fakeClick();
    const ctx = contextFromComponent(interaction as unknown as ButtonInteraction, resolved);
    await ctx.update("x");
    await ctx.reply("y");
    expect(calls[1]?.method).toBe("followUp");
  });
});

describe("prefix command replies", () => {
  test("a reply to a text command is a normal message with components", async () => {
    const sent: unknown[] = [];
    const message = {
      author: { id: "1", displayName: "t" },
      member: null,
      guildId: "10",
      channelId: "20",
      channel: { isDMBased: () => false },
      reply: async (payload: unknown) => void sent.push(payload),
    } as unknown as Message;
    await contextFromMessage(message, {}).reply({
      content: "menu",
      components: [[{ type: "button", customId: "m:n:1:", label: "OK" }]],
    });
    expect(sent[0]).toMatchObject({
      content: "menu",
      allowedMentions: { parse: [] },
      components: [{ type: ComponentType.ActionRow }],
    });
  });
});
