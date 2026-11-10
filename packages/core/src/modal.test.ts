import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  defineButton,
  defineCommand,
  defineModal,
  MODAL_MAX_TITLE,
  NOT_YOUR_MODAL,
  parseModalValues,
  REJECTED_MODAL_VALUE,
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

  test("a text field the adapter refused is invalid, while the word rejected typed by a member is fine", () => {
    const { feedback } = setup();
    expect(() =>
      parseModalValues(feedback.fields, { ...valid, topic: REJECTED_MODAL_VALUE }),
    ).toThrow("nieprawidłową wartość");
    expect(parseModalValues(feedback.fields, { ...valid, topic: "rejected" }).topic).toBe(
      "rejected",
    );
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

  describe("select fields", () => {
    const options = [
      { label: "Mała", value: "s", description: "do 10 osób" },
      { label: "Duża", value: "l" },
    ] as const;
    const picker = defineModal({
      module: "fun",
      name: "picker",
      title: "t",
      fields: {
        size: { type: "select", label: "Rozmiar", options, defaultValue: "l" },
        extra: { type: "select", label: "Dodatek", options, required: false },
      },
      async run(ctx) {
        // The union of option values is the type: this compiles only if `size` is "s" | "l".
        const size: "s" | "l" = ctx.values.size;
        const extra: "s" | "l" | undefined = ctx.values.extra;
        await ctx.reply(`${size}:${extra}`);
      },
    });
    const registry = createRegistry([{ name: "fun", modals: [picker] }]);
    const customId = picker.build(OWNER).customId;

    test("builds a spec with options and the default", () => {
      const [size] = picker.build(OWNER).fields;
      expect(size).toMatchObject({ type: "select", value: "l", options });
    });

    test("passes the chosen value, optional left empty is undefined", async () => {
      const ctx = await submitModal({ registry, customId, values: { size: ["s"] } });
      expect(ctx.replies).toEqual(["s:undefined"]);
    });

    test("a value that is not an option is refused", async () => {
      for (const forged of [["xl"], ["s", "l"], [" s"]]) {
        const ctx = await submitModal({ registry, customId, values: { size: forged } });
        expect(ctx.replies).toEqual([
          { content: "Pole „Rozmiar” ma nieprawidłową wartość.", ephemeral: true },
        ]);
      }
    });

    test("limits are checked", () => {
      const field = picker.build(OWNER).fields[0];
      if (!field) throw new Error("fixture lost a field");
      const check = (opts: { label: string; value: string }[], value?: string) =>
        validateModal({
          customId: "a:b:1:",
          title: "t",
          fields: [{ ...field, options: opts, value }],
        });
      const one = { label: "A", value: "a" };
      expect(() => check([])).toThrow("1–25 options");
      expect(() =>
        check(Array.from({ length: 26 }, (_, i) => ({ label: "A", value: `v${i}` }))),
      ).toThrow("1–25 options");
      expect(() => check([{ label: "", value: "a" }])).toThrow("label");
      expect(() => check([{ label: "A", value: "x".repeat(101) }])).toThrow("value");
      expect(() => check([one, one])).toThrow("duplicate option");
      expect(() => check([one], "b")).toThrow("not one of the options");
      expect(() => check([one], "a")).not.toThrow();
    });
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

describe("multi-user select and file upload", () => {
  const A = "300000000000000003";
  const B = "300000000000000004";
  const seen: unknown[] = [];
  const invite = defineModal({
    module: "fun",
    name: "invite",
    title: "Zaproszenie",
    fields: {
      people: { type: "user", label: "Kogo", minValues: 1, maxValues: 3 },
      one: { type: "user", label: "Jedna osoba", required: false },
      proof: {
        type: "file",
        label: "Plik",
        required: false,
        contentTypes: ["image/*", "application/pdf"],
        maxBytes: 1_048_576,
      },
    },
    async run(ctx) {
      // Compiles only if a user select with maxValues above 1 is string[] and a file is a ModalFile.
      const people: string[] = ctx.values.people;
      const one: string | undefined = ctx.values.one;
      seen.push({ people, one, proof: ctx.values.proof });
    },
  });
  const registry = createRegistry([{ name: "fun", modals: [invite] }]);
  const customId = invite.build(OWNER).customId;
  const png = {
    url: "https://cdn.discordapp.com/a.png",
    name: "a.png",
    contentType: "image/png",
    size: 5000,
  };
  const refusal = (text: string) => [{ content: text, ephemeral: true }];

  test("the spec carries the value range", () => {
    const [people, one, proof] = invite.build(OWNER).fields;
    expect(people).toMatchObject({ type: "user", minValues: 1, maxValues: 3, required: true });
    expect(one).toMatchObject({ type: "user", maxValues: undefined });
    expect(proof).toMatchObject({ type: "file", required: false });
  });

  test("a multi-value user select hands over the distinct ids", async () => {
    seen.length = 0;
    await submitModal({ registry, customId, values: { people: [A, B, A] } });
    expect(seen).toEqual([{ people: [A, B], one: undefined, proof: undefined }]);
  });

  test("too many, too few and forged ids are refused", async () => {
    seen.length = 0;
    const many = await submitModal({
      registry,
      customId,
      values: { people: [A, B, "500000000000000005", "500000000000000006"] },
    });
    expect(many.replies).toEqual(refusal("Pole „Kogo” ma nieprawidłową wartość."));
    const none = await submitModal({ registry, customId, values: { people: [] } });
    expect(none.replies).toEqual(refusal("Pole „Kogo” jest wymagane."));
    const forged = await submitModal({ registry, customId, values: { people: [A, "rejected"] } });
    expect(forged.replies).toEqual(refusal("Pole „Kogo” ma nieprawidłową wartość."));
    expect(seen).toEqual([]);
  });

  test("a single-value user select keeps handing over one id", async () => {
    seen.length = 0;
    await submitModal({ registry, customId, values: { people: [A], one: [B] } });
    expect(seen).toEqual([{ people: [A], one: B, proof: undefined }]);
    const two = await submitModal({ registry, customId, values: { people: [A], one: [A, B] } });
    expect(two.replies).toEqual(refusal("Pole „Jedna osoba” ma nieprawidłową wartość."));
  });

  test("a file is passed on with url, name, type and size", async () => {
    seen.length = 0;
    await submitModal({ registry, customId, values: { people: [A], proof: [png] } });
    expect(seen).toEqual([{ people: [A], one: undefined, proof: png }]);
  });

  test("a type outside the allowed list, a missing type and a big file are refused", async () => {
    const submit = (proof: unknown) =>
      submitModal({ registry, customId, values: { people: [A], proof } as never });
    expect((await submit([{ ...png, contentType: "text/html" }])).replies).toEqual(
      refusal("Plik w polu „Plik” ma niedozwolony typ."),
    );
    expect((await submit([{ ...png, contentType: null }])).replies).toEqual(
      refusal("Plik w polu „Plik” ma niedozwolony typ."),
    );
    expect((await submit([{ ...png, size: 2_000_000 }])).replies).toEqual(
      refusal("Plik w polu „Plik” może mieć najwyżej 1 MB."),
    );
    seen.length = 0;
    await submit([{ ...png, contentType: "application/PDF; charset=binary" }]);
    expect(seen).toHaveLength(1);
  });

  test("a forged or unresolved file is an invalid value", async () => {
    const invalid = refusal("Pole „Plik” ma nieprawidłową wartość.");
    for (const forged of [
      "rejected",
      [png, png],
      [{ url: "http://evil.example/a.png", name: "a", contentType: "image/png", size: 1 }],
      [{ url: png.url, name: "a", contentType: "image/png", size: "big" }],
      ["123"],
    ]) {
      const ctx = await submitModal({
        registry,
        customId,
        values: { people: [A], proof: forged } as never,
      });
      expect(ctx.replies).toEqual(invalid);
    }
  });

  test("a required file must be uploaded", () => {
    const fields = { proof: { type: "file", label: "Plik" } } as const;
    expect(() => parseModalValues(fields, {})).toThrow("jest wymagane");
    expect(() => parseModalValues(fields, { proof: [] })).toThrow("jest wymagane");
  });

  test("value ranges are validated when the modal is built", () => {
    const build = (extra: object) =>
      defineModal({
        module: "fun",
        name: "range",
        title: "t",
        fields: { people: { type: "user", label: "Kogo", ...extra } },
        async run() {},
      }).build(OWNER);
    expect(() => build({ maxValues: 26 })).toThrow("maxValues 1–25");
    expect(() => build({ minValues: 3, maxValues: 2 })).toThrow("greater than maxValues");
    expect(() => build({ minValues: 0 })).toThrow("at least 1");
    expect(() => build({ minValues: 0, required: false, maxValues: 5 })).not.toThrow();
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

describe("file field definitions", () => {
  const fileModal = (field: { contentTypes?: string[]; maxBytes?: number }) =>
    defineModal({
      module: "fun",
      name: "file",
      title: "t",
      fields: { f: { type: "file", label: "Plik", ...field } },
      async run() {},
    });

  test("a valid definition builds and its limits reach the spec", () => {
    const spec = fileModal({ contentTypes: ["image/*", "application/pdf"], maxBytes: 1024 }).build(
      "1",
    );
    expect(spec.fields[0]).toMatchObject({
      contentTypes: ["image/*", "application/pdf"],
      maxBytes: 1024,
    });
  });

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "maxBytes %p is refused",
    (maxBytes) => {
      expect(() => fileModal({ maxBytes }).build("1")).toThrow(
        "maxBytes must be a positive integer",
      );
    },
  );

  test("an empty contentTypes list is refused", () => {
    expect(() => fileModal({ contentTypes: [] }).build("1")).toThrow("at least one type");
  });

  test.each(["pdf", "image", "image/", "/png", "image/*; charset=x", "image /png", "*/*x", ""])(
    "contentTypes entry %p is refused",
    (type) => {
      expect(() => fileModal({ contentTypes: [type] }).build("1")).toThrow("is not a content type");
    },
  );
});
