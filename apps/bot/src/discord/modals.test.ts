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
    size: {
      type: "select",
      label: "Rozmiar",
      required: false,
      options: [
        { label: "Mała", value: "s", description: "do 10" },
        { label: "Duża", value: "l" },
      ],
      defaultValue: "l",
    },
  },
  async run() {},
});

describe("toModalPayload", () => {
  test("shows every text in the member's language", () => {
    const localized = defineModal({
      module: "fun",
      name: "sized",
      title: { pl: "Rozmiar", en: "Size", de: "Größe" },
      fields: {
        size: {
          type: "select",
          label: { pl: "Wybierz", en: "Pick", de: "Wähle" },
          description: { pl: "jeden", en: "one", de: "eins" },
          placeholder: { pl: "nic", en: "nothing", de: "nichts" },
          options: [{ label: { pl: "Mała", en: "Small", de: "Klein" }, value: "s" }],
        },
      },
      async run() {},
    });
    const payload = toModalPayload(localized.build("1"), "de");
    expect(payload.title).toBe("Größe");
    expect(payload.components[0]).toMatchObject({
      label: "Wähle",
      description: "eins",
      component: { placeholder: "nichts", options: [{ label: "Klein", value: "s" }] },
    });
  });

  test("wraps every field in a Label component", () => {
    const payload = toModalPayload(modal.build("1", "d"), "pl");
    expect(payload.custom_id).toBe("fun:form:1:d");
    expect(payload.title).toBe("Formularz");
    expect(payload.components.map((c) => ("component" in c ? c.component.type : null))).toEqual([
      ComponentType.TextInput,
      ComponentType.TextInput,
      ComponentType.ChannelSelect,
      ComponentType.UserSelect,
      ComponentType.StringSelect,
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
    expect(payload.components[4]).toMatchObject({
      component: {
        min_values: 0,
        max_values: 1,
        options: [
          { label: "Mała", value: "s", description: "do 10", default: false },
          { label: "Duża", value: "l", default: true },
        ],
      },
    });
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

const upload = (
  ...files: { id: string; url: string; name: string; contentType: string | null; size: number }[]
) => ({
  type: ComponentType.FileUpload,
  values: files.map((f) => f.id),
  attachments: new Map(files.map((f) => [f.id, f])),
});
const FILE = {
  id: "9",
  url: "https://cdn.discordapp.com/a.png",
  name: "a.png",
  contentType: "image/png",
  size: 12,
};

const attach = defineModal({
  module: "fun",
  name: "attach",
  title: "Załącznik",
  fields: {
    team: { type: "user", label: "Zespół", required: false, minValues: 1, maxValues: 10 },
    proof: { type: "file", label: "Plik", required: false },
  },
  async run() {},
});

describe("multi-user select and file upload", () => {
  test("the payload asks Discord for the value range and a file upload", () => {
    const payload = toModalPayload(attach.build("1"), "pl");
    const inner = payload.components.map((c) => ("component" in c ? c.component : null));
    expect(inner[0]).toMatchObject({
      type: ComponentType.UserSelect,
      // The field is optional, so the client may leave it empty even though minValues is 1.
      min_values: 0,
      max_values: 10,
    });
    expect(inner[1]).toMatchObject({
      type: ComponentType.FileUpload,
      custom_id: "proof",
      required: false,
      min_values: 0,
      max_values: 1,
    });
  });

  test("the file filter follows contentTypes where Discord has an equivalent", () => {
    const fileTypes = (contentTypes?: string[]) => {
      const m = defineModal({
        module: "fun",
        name: "ft",
        title: "t",
        fields: { f: { type: "file", label: "Plik", contentTypes } },
        async run() {},
      });
      const field = toModalPayload(m.build("1"), "pl").components[0];
      return field && "component" in field && "file_types" in field.component
        ? field.component.file_types
        : "missing";
    };
    expect(fileTypes(["image/*", "video/*", "application/pdf"])).toEqual([
      "image",
      "video",
      ".pdf",
    ]);
    expect(fileTypes(["IMAGE/*"])).toEqual(["image"]);
    // A type with no equivalent would make the picker stricter than the field: no filter at all.
    expect(fileTypes(["image/*", "application/zip"])).toBeUndefined();
    expect(fileTypes(["image/png"])).toBeUndefined();
    expect(fileTypes(undefined)).toBeUndefined();
  });

  test("an optional user select always allows an empty pick, a required one asks for at least one", () => {
    const users = (required: boolean, minValues?: number) => {
      const m = defineModal({
        module: "fun",
        name: "us",
        title: "t",
        fields: { u: { type: "user", label: "Kto", required, minValues, maxValues: 5 } },
        async run() {},
      });
      const field = toModalPayload(m.build("1"), "pl").components[0];
      return field && "component" in field && "min_values" in field.component
        ? field.component.min_values
        : "missing";
    };
    expect(users(false)).toBe(0);
    expect(users(false, 2)).toBe(0);
    expect(users(true)).toBe(1);
    expect(users(true, 3)).toBe(3);
  });

  test("a required upload asks for one file", () => {
    const required = defineModal({
      module: "fun",
      name: "req",
      title: "t",
      fields: { proof: { type: "file", label: "Plik" } },
      async run() {},
    });
    const [label] = toModalPayload(required.build("1"), "pl").components;
    expect(label && "component" in label ? label.component : null).toMatchObject({
      required: true,
      min_values: 1,
      max_values: 1,
    });
  });

  test("resolved attachments become files, an unresolved id or another component is rejected", () => {
    const ok = submit({ proof: upload(FILE), team: users("7", "8") });
    expect(readModalValues(attach, ok.interaction)).toEqual({
      proof: [{ url: FILE.url, name: "a.png", contentType: "image/png", size: 12 }],
      team: ["7", "8"],
    });
    const unresolved = submit({
      proof: { type: ComponentType.FileUpload, values: ["9"], attachments: new Map() },
    });
    expect(readModalValues(attach, unresolved.interaction)).toEqual({
      proof: REJECTED_MODAL_VALUE,
    });
    const wrongType = submit({ proof: text("x") });
    expect(readModalValues(attach, wrongType.interaction)).toEqual({ proof: REJECTED_MODAL_VALUE });
  });

  test("an empty upload reads as no files", () => {
    const { interaction } = submit({ proof: upload() });
    expect(readModalValues(attach, interaction)).toEqual({ proof: [] });
  });
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

  test("a string select is read, a forged type for it is rejected", () => {
    const ok = submit({ size: { type: ComponentType.StringSelect, values: ["s"] } });
    expect(readModalValues(modal, ok.interaction)).toEqual({ size: ["s"] });
    const forged = submit({ size: text("s") });
    expect(readModalValues(modal, forged.interaction)).toEqual({ size: REJECTED_MODAL_VALUE });
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

  test("an ephemeral defer on a modal from a message starts a private reply and leaves the message", async () => {
    const fromMessage = submit({}, true);
    const ctx = contextFromModal(fromMessage.interaction, "");
    await ctx.defer({ ephemeral: true });
    await ctx.reply({ content: "gotowe" });
    expect(fromMessage.calls.map((c) => c.method)).toEqual(["deferReply", "followUp"]);
    expect(fromMessage.calls[0]?.payload).toMatchObject({ flags: 64 });
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
      isUserSelectMenu: () => false,
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
      isUserSelectMenu: () => false,
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
