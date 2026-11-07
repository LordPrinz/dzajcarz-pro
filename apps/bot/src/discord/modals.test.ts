import { describe, expect, test } from "bun:test";
import { defineModal } from "@dzajcarz/core";
import {
  ChannelType,
  ComponentType,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  TextInputStyle,
} from "discord.js";
import { contextFromComponent } from "./component-context.ts";
import { contextFromMessage } from "./context.ts";
import { contextFromModal } from "./modal-context.ts";
import { readModalValues, toModalPayload } from "./modals.ts";

const modal = defineModal({
  module: "fun",
  name: "form",
  title: "Formularz",
  fields: {
    name: { type: "short", label: "Imię", minLength: 2, maxLength: 10, placeholder: "np. Ola" },
    note: { type: "paragraph", label: "Notatka", required: false, description: "opcjonalnie" },
    room: { type: "channel", label: "Kanał", channelTypes: ["text", "voice"], defaultValue: "42" },
    who: { type: "user", label: "Kto", required: false },
  },
  async run() {},
});

describe("toModalPayload", () => {
  test("wraps every field in a Label component", () => {
    const payload = toModalPayload(modal.build("1", "d"));
    expect(payload.custom_id).toBe("fun:form:1:d");
    expect(payload.title).toBe("Formularz");
    expect(payload.components.map((c) => ("component" in c ? c.component.type : null))).toEqual([
      ComponentType.TextInput,
      ComponentType.TextInput,
      ComponentType.ChannelSelect,
      ComponentType.UserSelect,
    ]);
    expect(payload.components[0]).toMatchObject({
      type: ComponentType.Label,
      label: "Imię",
      component: {
        custom_id: "name",
        style: TextInputStyle.Short,
        min_length: 2,
        max_length: 10,
        required: true,
        placeholder: "np. Ola",
      },
    });
    expect(payload.components[1]).toMatchObject({
      description: "opcjonalnie",
      component: { style: TextInputStyle.Paragraph, required: false },
    });
    expect(payload.components[2]).toMatchObject({
      component: {
        channel_types: [ChannelType.GuildText, ChannelType.GuildVoice],
        min_values: 1,
        max_values: 1,
        default_values: [{ id: "42", type: "channel" }],
      },
    });
    expect(payload.components[3]).toMatchObject({ component: { min_values: 0, max_values: 1 } });
  });
});

function submit(fields: Record<string, unknown>, fromMessage = false) {
  const calls: { method: string; payload?: unknown }[] = [];
  const record = (method: string) => async (payload?: unknown) => {
    calls.push({ method, payload });
  };
  const interaction = {
    user: { id: "1", displayName: "t" },
    guildId: "100000000000000001",
    channelId: "300000000000000003",
    inGuild: () => true,
    memberPermissions: { bitfield: 0n },
    fields: { fields: new Map(Object.entries(fields)) },
    message: fromMessage ? { id: "msg" } : null,
    isFromMessage: () => fromMessage,
    update: record("update"),
    deferUpdate: record("deferUpdate"),
    deferReply: record("deferReply"),
    reply: record("reply"),
    editReply: record("editReply"),
    followUp: record("followUp"),
  } as unknown as ModalSubmitInteraction;
  return { interaction, calls };
}

describe("readModalValues", () => {
  test("reads text values and select ids, skipping other component data", () => {
    const { interaction } = submit({
      name: { value: "Ola" },
      room: { values: ["42"] },
      who: { value: null },
    });
    expect(readModalValues(modal, interaction)).toEqual({ name: "Ola", room: ["42"] });
  });
});

describe("contextFromModal", () => {
  test("reply is ephemeral, then follows up", async () => {
    const { interaction, calls } = submit({});
    const ctx = contextFromModal(interaction, "s");
    expect(ctx.state).toBe("s");
    expect(ctx.acknowledged).toBe(false);
    await ctx.reply("a");
    await ctx.reply("b");
    expect(ctx.acknowledged).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["reply", "followUp"]);
    expect(calls[0]?.payload).toMatchObject({ flags: 64, allowedMentions: { parse: [] } });
  });

  test("defer and update follow the origin of the modal", async () => {
    const fromMessage = submit({}, true);
    const a = contextFromModal(fromMessage.interaction, "");
    await a.defer();
    await a.update({ content: "x" });
    expect(fromMessage.calls.map((c) => c.method)).toEqual(["deferUpdate", "editReply"]);

    const fromSlash = submit({});
    const b = contextFromModal(fromSlash.interaction, "");
    await b.defer();
    expect(fromSlash.calls.map((c) => c.method)).toEqual(["deferReply"]);
    await expect(b.update({ content: "x" })).rejects.toThrow("message component");
  });
});

describe("opening", () => {
  test("a component click shows the modal and counts as answered", async () => {
    const shown: unknown[] = [];
    const interaction = {
      user: { id: "1", displayName: "t" },
      guildId: null,
      channelId: "3",
      inGuild: () => false,
      isStringSelectMenu: () => false,
      showModal: async (payload: unknown) => {
        shown.push(payload);
      },
    } as unknown as MessageComponentInteraction;
    const ctx = contextFromComponent(
      interaction as never,
      {
        state: "",
      } as never,
    );
    await ctx.showModal(modal.build("1"));
    expect(shown).toHaveLength(1);
    expect(ctx.acknowledged).toBe(true);
  });

  test("a prefix message cannot open one", async () => {
    const message = {
      author: { id: "1", displayName: "t" },
      guildId: null,
      channelId: "3",
      channel: { isDMBased: () => true },
    };
    const ctx = contextFromMessage(message as never, {});
    expect(ctx.canShowModal).toBe(false);
    await expect(ctx.showModal(modal.build("1"))).rejects.toThrow("canShowModal");
  });
});
