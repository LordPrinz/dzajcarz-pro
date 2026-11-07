import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  defineButton,
  defineCommand,
  defineModal,
  MODAL_MAX_TITLE,
  NOT_YOUR_MODAL,
  parseModalValues,
  UNKNOWN_MODAL,
  validateModal,
} from "./index.ts";
import {
  clickComponent,
  createFakeComponentContext,
  createFakeContext,
  createFakeModalContext,
  replyText,
  submitModal,
} from "./testing/context.ts";

const OWNER = "200000000000000002";
const CHANNEL = "400000000000000004";

function setup() {
  const seen: unknown[] = [];
  const feedback = defineModal({
    module: "fun",
    name: "feedback",
    title: "Opinia",
    fields: {
      topic: { type: "short", label: "Temat", minLength: 3, maxLength: 20 },
      body: { type: "paragraph", label: "Treść", required: false, defaultValue: "Hej" },
      channel: { type: "channel", label: "Kanał", channelTypes: ["text"], required: false },
      friend: { type: "user", label: "Kto" },
    },
    async run(ctx) {
      seen.push({ ...ctx.values, state: ctx.state });
      await ctx.reply("dzięki");
    },
  });
  const open = defineCommand({
    name: "opinia",
    description: "Formularz",
    async run(ctx) {
      if (!ctx.canShowModal) {
        await ctx.reply("Użyj /opinia");
        return;
      }
      await ctx.showModal(feedback.build(ctx.user.id, "v1", { topic: "Start" }));
    },
  });
  const button = defineButton({
    module: "fun",
    name: "open",
    async run(ctx) {
      await ctx.showModal(feedback.build(ctx.user.id));
    },
  });
  const registry = createRegistry([
    { name: "fun", commands: [open], components: [button], modals: [feedback] },
  ]);
  return { seen, feedback, open, button, registry };
}

const valid = { topic: "Pomysł", friend: ["300000000000000003"] };

describe("opening a modal", () => {
  test("a slash command opens it with defaults", async () => {
    const { open } = setup();
    const ctx = createFakeContext({});
    await open.run?.(ctx);
    const [spec] = ctx.modals;
    expect(spec?.customId).toBe(`fun:feedback:${OWNER}:v1`);
    expect(spec?.fields.map((f) => [f.customId, f.type, f.required, f.value])).toEqual([
      ["topic", "short", true, "Start"],
      ["body", "paragraph", false, "Hej"],
      ["channel", "channel", false, undefined],
      ["friend", "user", true, undefined],
    ]);
  });

  test("a prefix command cannot open one and checks canShowModal", async () => {
    const { open, feedback } = setup();
    const ctx = createFakeContext({ invocation: "prefix" });
    expect(ctx.canShowModal).toBe(false);
    await open.run?.(ctx);
    expect(ctx.replies).toEqual(["Użyj /opinia"]);
    await expect(ctx.showModal(feedback.build(OWNER))).rejects.toThrow("canShowModal");
  });

  test("a button click opens it and counts as the answer", async () => {
    const { registry, button } = setup();
    const ctx = await clickComponent({ registry, customId: button.customId(OWNER) });
    expect(ctx.modals).toHaveLength(1);
    expect(ctx.deferred).toBe(false);
  });

  test("showModal must be the first answer in the fakes", async () => {
    const spec = setup().feedback.build(OWNER);
    const deferred = createFakeContext();
    await deferred.defer();
    await expect(deferred.showModal(spec)).rejects.toThrow("first answer");
    const replied = createFakeContext();
    await replied.reply("x");
    await expect(replied.showModal(spec)).rejects.toThrow("first answer");
    const twice = createFakeContext();
    await twice.showModal(spec);
    await expect(twice.showModal(spec)).rejects.toThrow("first answer");

    for (const answer of ["defer", "reply", "update"] as const) {
      const ctx = createFakeComponentContext();
      if (answer === "defer") await ctx.defer();
      else if (answer === "reply") await ctx.reply("x");
      else await ctx.update("x");
      await expect(ctx.showModal(spec)).rejects.toThrow("first answer");
    }
    const first = createFakeComponentContext();
    await first.showModal(spec);
    expect(first.modals).toHaveLength(1);
  });

  test("refuses a spec that breaks a Discord limit", async () => {
    const ctx = createFakeComponentContext();
    const spec = setup().feedback.build(OWNER);
    await expect(
      ctx.showModal({ ...spec, title: "x".repeat(MODAL_MAX_TITLE + 1) }),
    ).rejects.toThrow("title");
    expect(() => validateModal({ ...spec, fields: [] })).toThrow("1–5 fields");
    expect(() => validateModal({ ...spec, fields: [...spec.fields, ...spec.fields] })).toThrow(
      "needs 1–5",
    );
  });
});

describe("submitting a modal", () => {
  test("passes typed values and the state to the handler", async () => {
    const { registry, seen, feedback } = setup();
    const ctx = await submitModal({
      registry,
      customId: feedback.build(OWNER, "x:y").customId,
      values: { ...valid, body: "", channel: [CHANNEL] },
    });
    expect(seen).toEqual([
      {
        topic: "Pomysł",
        body: undefined,
        channel: CHANNEL,
        friend: "300000000000000003",
        state: "x:y",
      },
    ]);
    expect(ctx.replies).toEqual(["dzięki"]);
  });

  test("an unanswered submit is deferred when it came from a message, else answered 'Gotowe.'", async () => {
    const quiet = defineModal({
      module: "fun",
      name: "quiet",
      title: "t",
      fields: { a: { type: "short", label: "A" } },
      async run() {},
    });
    const registry = createRegistry([{ name: "fun", modals: [quiet] }]);
    const customId = quiet.build(OWNER).customId;
    const fromMessage = await submitModal({
      registry,
      customId,
      values: { a: "x" },
      fromMessage: true,
    });
    expect(fromMessage.deferred).toBe(true);
    expect(fromMessage.replies).toEqual([]);
    const fromSlash = await submitModal({ registry, customId, values: { a: "x" } });
    expect(fromSlash.deferred).toBe(false);
    expect(fromSlash.replies).toEqual([{ content: "Gotowe.", ephemeral: true }]);
  });

  test("text is trimmed once, before the length checks", async () => {
    const { registry, seen, feedback } = setup();
    await submitModal({
      registry,
      customId: feedback.build(OWNER).customId,
      values: { ...valid, topic: "  Pomysł \n", body: "  hej  " },
    });
    expect(seen[0]).toMatchObject({ topic: "Pomysł", body: "hej" });
    expect(() => parseModalValues(feedback.fields, { ...valid, topic: "  ab  " })).toThrow(
      "od 3 do 20 znaków",
    );
    expect(
      parseModalValues(feedback.fields, { ...valid, topic: ` ${"x".repeat(20)} ` }).topic,
    ).toBe("x".repeat(20));
  });

  test("a handler may spread its context; the wrapper keeps working", async () => {
    const spreading = defineModal({
      module: "fun",
      name: "spread",
      title: "t",
      fields: { a: { type: "short", label: "A" } },
      async run(ctx) {
        const copy = { ...ctx };
        await copy.reply(`${copy.values.a}:${copy.state}:${ctx.acknowledged}`);
        await ctx.reply(`${ctx.acknowledged}`);
      },
    });
    const registry = createRegistry([{ name: "fun", modals: [spreading] }]);
    const ctx = await submitModal({
      registry,
      customId: spreading.build(OWNER, "s").customId,
      values: { a: "x" },
    });
    expect(ctx.replies).toEqual(["x:s:false", "true"]);
  });

  test("update works only for a modal opened from a message", async () => {
    const updating = defineModal({
      module: "fun",
      name: "updating",
      title: "t",
      fields: { a: { type: "short", label: "A" } },
      async run(ctx) {
        await ctx.update({ content: ctx.canUpdate ? "edited" : "never" });
      },
    });
    const registry = createRegistry([{ name: "fun", modals: [updating] }]);
    const customId = updating.build(OWNER).customId;
    const fromMessage = await submitModal({
      registry,
      customId,
      values: { a: "x" },
      fromMessage: true,
    });
    expect(fromMessage.updates).toEqual([{ content: "edited" }]);
    const fromSlash = await submitModal({ registry, customId, values: { a: "x" } });
    expect(fromSlash.updates).toEqual([]);
    expect(replyText(fromSlash.replies[0])).toContain("Coś poszło nie tak");
    expect(createFakeModalContext().canUpdate).toBe(false);
  });

  test("a missing required field is answered in Polish and the handler does not run", async () => {
    const { registry, seen, feedback } = setup();
    const ctx = await submitModal({
      registry,
      customId: feedback.build(OWNER).customId,
      values: { topic: "  ", friend: ["300000000000000003"] },
    });
    expect(seen).toEqual([]);
    expect(ctx.replies[0]).toEqual({ content: "Pole „Temat” jest wymagane.", ephemeral: true });
  });

  test("text outside min/max length and malformed ids are refused", () => {
    const { feedback } = setup();
    const parse = (raw: Record<string, string | string[]>) => () =>
      parseModalValues(feedback.fields, { ...valid, ...raw });
    expect(parse({ topic: "ab" })).toThrow("od 3 do 20 znaków");
    expect(parse({ topic: "x".repeat(21) })).toThrow("od 3 do 20 znaków");
    expect(parse({ friend: ["abc"] })).toThrow("nieprawidłową");
    expect(parse({ friend: ["1", "2"] })).toThrow("nieprawidłową");
    expect(parse({ friend: [] })).toThrow("wymagane");
    expect(parse({ channel: [CHANNEL] })).not.toThrow();
  });

  test("default values of selects must be snowflakes", () => {
    const spec = setup().feedback.build(OWNER);
    const pick = (type: "channel" | "user", value: string) => {
      const field = spec.fields.find((f) => f.type === type);
      if (!field) throw new Error("fixture lost a field");
      return { ...spec, fields: [{ ...field, value }] };
    };
    expect(() => validateModal(pick("channel", "general"))).toThrow("channel or user id");
    expect(() => validateModal(pick("user", "abc"))).toThrow("channel or user id");
    expect(() => validateModal(pick("user", CHANNEL))).not.toThrow();
  });

  test("an optional text with a max length only says 'do N'", () => {
    const fields = { a: { type: "short", label: "A", maxLength: 5 } } as const;
    expect(() => parseModalValues(fields, { a: "toolong" })).toThrow("musi mieć do 5 znaków");
  });

  test("only the owner may submit", async () => {
    const { registry, seen, feedback } = setup();
    const ctx = await submitModal({
      registry,
      customId: feedback.build(OWNER).customId,
      values: valid,
      userId: "999999999999999999",
    });
    expect(seen).toEqual([]);
    expect(replyText(ctx.replies[0])).toBe(NOT_YOUR_MODAL);
  });

  test("permissions and guildOnly are checked on submit", async () => {
    const guarded = defineModal({
      module: "fun",
      name: "guarded",
      title: "t",
      permissions: 1n << 5n,
      fields: { a: { type: "short", label: "A" } },
      async run(ctx) {
        await ctx.reply("ok");
      },
    });
    const registry = createRegistry([{ name: "fun", modals: [guarded] }]);
    const customId = guarded.build(OWNER).customId;
    const denied = await submitModal({ registry, customId, values: { a: "x" } });
    expect(replyText(denied.replies[0])).toBe("Nie masz uprawnień do tego formularza.");
    const dm = await submitModal({ registry, customId, values: { a: "x" }, guildId: null });
    expect(replyText(dm.replies[0])).toBe("Ten formularz działa tylko na serwerze.");
    const allowed = await submitModal({
      registry,
      customId,
      values: { a: "x" },
      memberPermissions: 1n << 5n,
    });
    expect(allowed.replies).toEqual(["ok"]);
  });

  test("an unknown modal gets the outdated message", async () => {
    const { registry } = setup();
    const ctx = await submitModal({ registry, customId: `fun:gone:${OWNER}:` });
    expect(ctx.replies[0]).toEqual({ content: UNKNOWN_MODAL, ephemeral: true });
  });

  test("a failing handler is answered with the generic message", async () => {
    const broken = defineModal({
      module: "fun",
      name: "broken",
      title: "t",
      fields: { a: { type: "short", label: "A" } },
      async run() {
        throw new Error("boom");
      },
    });
    const registry = createRegistry([{ name: "fun", modals: [broken] }]);
    const ctx = await submitModal({
      registry,
      customId: broken.build(OWNER).customId,
      values: { a: "x" },
    });
    expect(replyText(ctx.replies[0])).toContain("Coś poszło nie tak");
  });
});

describe("registry validation of modals", () => {
  const base = {
    module: "fun",
    name: "m",
    title: "t",
    async run() {},
  };
  const text = { type: "short", label: "A" } as const;
  const register = (modal: ReturnType<typeof defineModal>, module = "fun") =>
    createRegistry([{ name: module, modals: [modal] }]);

  test("accepts a valid modal and resolves it", () => {
    const m = defineModal({ ...base, fields: { a: text } });
    expect(register(m).resolveModal(m.build(OWNER, "d").customId)).toMatchObject({
      module: "fun",
      owner: OWNER,
      state: "d",
    });
    expect(register(m).resolveModal("fun:other:1:")).toBeUndefined();
  });

  test("rejects duplicates, wrong module and bad names", () => {
    const m = defineModal({ ...base, fields: { a: text } });
    expect(() => createRegistry([{ name: "fun", modals: [m, m] }])).toThrow("registered twice");
    expect(() => register(m, "other")).toThrow("belongs to module");
    expect(() => register(defineModal({ ...base, name: "Bad:Name", fields: { a: text } }))).toThrow(
      "Invalid modal",
    );
  });

  test("rejects Discord limit violations at startup", () => {
    const bad = (extra: object, fields: Record<string, object> = { a: text }) =>
      register(defineModal({ ...base, ...extra, fields } as never));
    expect(() => bad({ title: "x".repeat(46) })).toThrow("title");
    expect(() => bad({}, {})).toThrow("1–5 fields");
    const six = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((k) => [k, text]));
    expect(() => bad({}, six)).toThrow("1–5 fields");
    expect(() => bad({}, { a: { ...text, label: "x".repeat(46) } })).toThrow("label");
    expect(() => bad({}, { a: { ...text, placeholder: "x".repeat(101) } })).toThrow("placeholder");
    expect(() => bad({}, { a: { ...text, defaultValue: "x".repeat(4001) } })).toThrow("default");
    expect(() => bad({}, { a: { ...text, maxLength: 4001 } })).toThrow("maxLength");
    expect(() => bad({}, { a: { ...text, minLength: 5, maxLength: 2 } })).toThrow("greater");
    expect(() => bad({}, { ["k".repeat(101)]: text })).toThrow("field id");
    const long = defineModal({
      ...base,
      module: "m".repeat(30),
      name: "n".repeat(32),
      fields: { a: text },
    });
    expect(() => register(long, "m".repeat(30))).toThrow("too long");
  });
});
