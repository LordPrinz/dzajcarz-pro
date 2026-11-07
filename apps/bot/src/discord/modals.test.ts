import { describe, expect, test } from "bun:test";
import { defineModal, REJECTED_MODAL_VALUE } from "@dzajcarz/core";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  ComponentType,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  TextInputStyle,
} from "discord.js";
import { contextFromComponent } from "./component-context.ts";
import { contextFromInteraction, contextFromMessage } from "./context.ts";
import { contextFromModal } from "./modal-context.ts";
import { readModalValues, toModalPayload } from "./modals.ts";

const GUILD = "100000000000000001";

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

function submit(fields: Record<string, unknown>, fromMessage = false, guildId = GUILD) {
  const calls: { method: string; payload?: unknown }[] = [];
  const record = (method: string) => async (payload?: unknown) => {
    calls.push({ method, payload });
  };
  const interaction = {
    user: { id: "1", displayName: "t" },
    guildId,
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

const text = (value: string) => ({ type: ComponentType.TextInput, value });
const channels = (...list: { id: string; type: ChannelType; guildId?: string }[]) => ({
  type: ComponentType.ChannelSelect,
  values: list.map((c) => c.id),
  channels: new Map(list.map((c) => [c.id, c])),
});
const users = (...ids: string[]) => ({
  type: ComponentType.UserSelect,
  values: ids,
  users: new Map(ids.map((id) => [id, { id }])),
});

describe("readModalValues", () => {
  test("reads text values and select ids that Discord resolved", () => {
    const { interaction } = submit({
      name: text("Ola"),
      room: channels({ id: "42", type: ChannelType.GuildVoice, guildId: GUILD }),
      who: users("7"),
    });
    expect(readModalValues(modal, interaction)).toEqual({
      name: "Ola",
      room: ["42"],
      who: ["7"],
    });
  });

  test("skips fields that were not submitted or are empty", () => {
    const { interaction } = submit({ who: { type: ComponentType.UserSelect, values: [] } });
    expect(readModalValues(modal, interaction)).toEqual({ who: [] });
  });

  test("a forged component type is rejected", () => {
    const { interaction } = submit({
      name: users("7"),
      room: text("42"),
      who: channels({ id: "7", type: ChannelType.GuildText, guildId: GUILD }),
    });
    expect(readModalValues(modal, interaction)).toEqual({
      name: REJECTED_MODAL_VALUE,
      room: REJECTED_MODAL_VALUE,
      who: REJECTED_MODAL_VALUE,
    });
  });

  test("ids that Discord did not resolve are rejected", () => {
    const { interaction } = submit({
      room: { type: ComponentType.ChannelSelect, values: ["42"], channels: new Map() },
      who: { type: ComponentType.UserSelect, values: ["7"], users: new Map() },
    });
    expect(readModalValues(modal, interaction)).toEqual({
      room: [REJECTED_MODAL_VALUE],
      who: [REJECTED_MODAL_VALUE],
    });
  });

  test("a channel of a type the field does not allow is rejected", () => {
    const { interaction } = submit({
      room: channels({ id: "42", type: ChannelType.GuildCategory, guildId: GUILD }),
    });
    expect(readModalValues(modal, interaction)).toEqual({ room: [REJECTED_MODAL_VALUE] });
  });

  test("a channel of another guild is rejected, a DM submit has no guild to compare", () => {
    const foreign = channels({ id: "42", type: ChannelType.GuildText, guildId: "999" });
    expect(readModalValues(modal, submit({ room: foreign }).interaction)).toEqual({
      room: [REJECTED_MODAL_VALUE],
    });
    expect(
      readModalValues(modal, submit({ room: foreign }, false, null as never).interaction),
    ).toEqual({ room: ["42"] });
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

    expect(a.canUpdate).toBe(true);

    const fromSlash = submit({});
    const b = contextFromModal(fromSlash.interaction, "");
    await b.defer();
    expect(fromSlash.calls.map((c) => c.method)).toEqual(["deferReply"]);
    expect(b.canUpdate).toBe(false);
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

  test("a component click that was already answered cannot open one", async () => {
    const interaction = {
      user: { id: "1", displayName: "t" },
      guildId: null,
      channelId: "3",
      inGuild: () => false,
      isStringSelectMenu: () => false,
      deferUpdate: async () => {},
      showModal: async () => {},
    } as unknown as MessageComponentInteraction;
    const ctx = contextFromComponent(interaction as never, { state: "" } as never);
    await ctx.defer();
    await expect(ctx.showModal(modal.build("1"))).rejects.toThrow("first answer");
  });

  test("a slash command shows the modal, once and only as the first answer", async () => {
    const shown: unknown[] = [];
    const base = {
      user: { id: "1", displayName: "t" },
      guildId: null,
      channelId: "3",
      context: null,
      options: { data: [], getSubcommand: () => null },
      commandName: "x",
      inGuild: () => false,
      showModal: async (payload: unknown) => {
        shown.push(payload);
      },
    };
    const ctx = contextFromInteraction({
      ...base,
      deferred: false,
      replied: false,
    } as unknown as ChatInputCommandInteraction);
    expect(ctx.canShowModal).toBe(true);
    await ctx.showModal(modal.build("1"));
    expect(shown).toHaveLength(1);
    expect((shown[0] as { custom_id: string }).custom_id).toBe("fun:form:1:");

    for (const state of [
      { deferred: true, replied: false },
      { deferred: false, replied: true },
    ]) {
      const late = contextFromInteraction({
        ...base,
        ...state,
      } as unknown as ChatInputCommandInteraction);
      await expect(late.showModal(modal.build("1"))).rejects.toThrow("first answer");
    }
    expect(shown).toHaveLength(1);
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
