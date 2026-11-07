import { describe, expect, test } from "bun:test";
import {
  type ComponentRow,
  createComponentStateStore,
  createPaginator,
  createRegistry,
  defineButton,
  defineSelect,
  ExpiredStateError,
  MAX_COMPONENT_PREFIX,
  MENU_EXPIRED,
  NOT_YOUR_MENU,
  parseCustomId,
  STATE_KEY_LENGTH,
  UNKNOWN_COMPONENT,
  UserError,
  validateRows,
} from "./index.ts";
import {
  clickComponent,
  createFakeComponentContext,
  createFakeContext,
} from "./testing/context.ts";

const OWNER = "200000000000000002";
const STRANGER = "999999999999999999";

function setup() {
  const clicks: string[] = [];
  const confirm = defineButton({
    module: "fun",
    name: "confirm",
    async run(ctx) {
      clicks.push(`confirm:${ctx.state}`);
      await ctx.update({ content: "done", components: [] });
    },
  });
  const pick = defineSelect({
    module: "fun",
    name: "pick",
    async run(ctx) {
      clicks.push(`pick:${ctx.values.join(",")}`);
      await ctx.reply("chosen");
    },
  });
  const admin = defineButton({
    module: "fun",
    name: "admin",
    permissions: 1n << 5n,
    async run() {
      clicks.push("admin");
    },
  });
  const boom = defineButton({
    module: "fun",
    name: "boom",
    async run(ctx) {
      if (ctx.state === "user") throw new UserError("Nie teraz.");
      throw new Error("db password leaked");
    },
  });
  const registry = createRegistry([{ name: "fun", components: [confirm, pick, admin, boom] }]);
  return { clicks, confirm, pick, admin, boom, registry };
}

describe("custom_id", () => {
  test("carries module, component, owner and state; the state may hold colons", () => {
    const { confirm } = setup();
    const id = confirm.customId(OWNER, "3:a:b");
    expect(id).toBe(`fun:confirm:${OWNER}:3:a:b`);
    expect(parseCustomId(id)).toEqual({
      module: "fun",
      name: "confirm",
      owner: OWNER,
      data: "3:a:b",
    });
    expect(parseCustomId("nonsense")).toBeNull();
  });

  test("refuses state that would not fit into 100 characters", () => {
    const { confirm } = setup();
    expect(() => confirm.customId(OWNER, "x".repeat(100))).toThrow("ComponentStateStore");
  });

  test("refuses an owner that would shift the fields", () => {
    const { confirm } = setup();
    expect(() => confirm.customId("a:b")).toThrow();
    expect(() => confirm.customId("")).toThrow();
  });
});

describe("registry", () => {
  test("rejects a duplicate component id within a module", () => {
    const a = defineButton({ module: "fun", name: "x", run: async () => {} });
    expect(() => createRegistry([{ name: "fun", components: [a, a] }])).toThrow("twice");
  });

  test("allows the same component name in different modules", () => {
    const a = defineButton({ module: "a", name: "x", run: async () => {} });
    const b = defineButton({ module: "b", name: "x", run: async () => {} });
    expect(() =>
      createRegistry([
        { name: "a", components: [a] },
        { name: "b", components: [b] },
      ]),
    ).not.toThrow();
  });

  test("rejects a component declared by another module", () => {
    const a = defineButton({ module: "other", name: "x", run: async () => {} });
    expect(() => createRegistry([{ name: "fun", components: [a] }])).toThrow("other");
  });

  test("rejects names with a colon or capitals", () => {
    for (const name of ["a:b", "Page", ""]) {
      const c = defineButton({ module: "fun", name, run: async () => {} });
      expect(() => createRegistry([{ name: "fun", components: [c] }])).toThrow("Invalid");
    }
  });

  test("rejects a prefix too long to leave room for the owner id", () => {
    const module = "m".repeat(MAX_COMPONENT_PREFIX);
    const c = defineButton({ module, name: "x".repeat(32), run: async () => {} });
    expect(() => createRegistry([{ name: module, components: [c] }])).toThrow("too long");
  });

  test("resolves a custom_id by its prefix", () => {
    const { registry, confirm } = setup();
    const resolved = registry.resolveComponent(confirm.customId(OWNER, "7"));
    expect(resolved).toMatchObject({ module: "fun", owner: OWNER, state: "7" });
    expect(resolved?.component).toBe(confirm);
    expect(registry.resolveComponent(`fun:missing:${OWNER}:`)).toBeUndefined();
    expect(registry.resolveComponent("other:confirm:1:")).toBeUndefined();
  });
});

describe("clicking", () => {
  test("a button handler gets its state and can update the message", async () => {
    const { registry, confirm, clicks } = setup();
    const ctx = await clickComponent({ registry, customId: confirm.customId(OWNER, "42") });
    expect(clicks).toEqual(["confirm:42"]);
    expect(ctx.updates).toEqual([{ content: "done", components: [] }]);
  });

  test("a select handler gets the chosen values", async () => {
    const { registry, pick, clicks } = setup();
    const ctx = await clickComponent({
      registry,
      customId: pick.customId(OWNER),
      values: ["a", "b"],
    });
    expect(clicks).toEqual(["pick:a,b"]);
    expect(ctx.replies).toEqual(["chosen"]);
  });

  test("another member is refused with an ephemeral reply and the handler does not run", async () => {
    const { registry, confirm, clicks } = setup();
    const ctx = await clickComponent({
      registry,
      customId: confirm.customId(OWNER),
      userId: STRANGER,
    });
    expect(clicks).toEqual([]);
    expect(ctx.replies).toEqual([{ content: NOT_YOUR_MENU, ephemeral: true }]);
    expect(NOT_YOUR_MENU).toBe("To nie Twoje menu.");
  });

  test("component permissions are checked like command permissions", async () => {
    const { registry, admin, clicks } = setup();
    const denied = await clickComponent({
      registry,
      customId: admin.customId(OWNER),
      memberPermissions: 0n,
    });
    expect(clicks).toEqual([]);
    expect(denied.replies).toEqual([
      { content: "Nie masz uprawnień do tego menu.", ephemeral: true },
    ]);
    await clickComponent({
      registry,
      customId: admin.customId(OWNER),
      memberPermissions: 1n << 5n,
    });
    expect(clicks).toEqual(["admin"]);
    const dm = await clickComponent({ registry, customId: admin.customId(OWNER), guildId: null });
    expect(dm.replies).toEqual([{ content: "To menu działa tylko na serwerze.", ephemeral: true }]);
  });

  test("a UserError is shown, any other error is hidden behind a generic message", async () => {
    const { registry, boom } = setup();
    const user = await clickComponent({ registry, customId: boom.customId(OWNER, "user") });
    expect(user.replies).toEqual([{ content: "Nie teraz.", ephemeral: true }]);
    const other = await clickComponent({ registry, customId: boom.customId(OWNER, "other") });
    expect(JSON.stringify(other.replies)).not.toContain("password");
    expect(other.replies).toHaveLength(1);
  });

  test("a handler that answers nothing is deferred; one that answered is not", async () => {
    const quiet = defineButton({ module: "fun", name: "quiet", run: async () => {} });
    const loud = defineButton({
      module: "fun",
      name: "loud",
      run: (ctx) => ctx.update("hi"),
    });
    const early = defineButton({
      module: "fun",
      name: "early",
      async run(ctx) {
        await ctx.defer();
        await ctx.update("later");
      },
    });
    const registry = createRegistry([{ name: "fun", components: [quiet, loud, early] }]);
    const q = await clickComponent({ registry, customId: quiet.customId(OWNER) });
    expect(q.deferred).toBe(true);
    expect(q.acknowledged).toBe(true);
    const l = await clickComponent({ registry, customId: loud.customId(OWNER) });
    expect(l.deferred).toBe(false);
    const e = await clickComponent({ registry, customId: early.customId(OWNER) });
    expect(e.deferred).toBe(true);
    expect(e.updates).toEqual(["later"]);
  });

  test("an unknown custom_id gets an ephemeral notice", async () => {
    const { registry } = setup();
    const ctx = await clickComponent({ registry, customId: "gone:thing:1:" });
    expect(ctx.replies).toEqual([{ content: UNKNOWN_COMPONENT, ephemeral: true }]);
  });
});

describe("validateRows", () => {
  const button = (customId: string) => ({ type: "button" as const, customId, label: "x" });

  test("accepts buttons, a link and a select in their own row", () => {
    expect(() =>
      validateRows([
        [button("a"), { type: "link", url: "https://discord.com", label: "Dodaj" }],
        [{ type: "select", customId: "s", options: [{ label: "A", value: "a" }] }],
      ]),
    ).not.toThrow();
  });

  test("rejects what Discord would refuse", () => {
    const select = {
      type: "select" as const,
      customId: "s",
      options: [{ label: "A", value: "a" }],
    };
    expect(() => validateRows([[select, button("a")]])).toThrow("whole row");
    expect(() => validateRows([Array.from({ length: 6 }, (_, i) => button(`b${i}`))])).toThrow(
      "more than 5",
    );
    expect(() => validateRows(Array.from({ length: 6 }, () => [button("a")]))).toThrow("at most 5");
    expect(() => validateRows([[]])).toThrow("empty");
    expect(() => validateRows([[button("x".repeat(101))]])).toThrow("custom_id");
    expect(() => validateRows([[{ ...select, options: [] }]])).toThrow("options");
    expect(() => validateRows([[{ type: "link", url: "nope", label: "x" }]])).toThrow("URL");
  });

  describe("limits", () => {
    const select = (over: object = {}) => ({
      type: "select" as const,
      customId: "s",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      ...over,
    });
    const reject = (row: ComponentRow, message: string) =>
      expect(() => validateRows([row])).toThrow(message);

    test("duplicate custom_id in one message", () => {
      expect(() => validateRows([[button("a")], [button("a")]])).toThrow("duplicate custom_id");
    });
    test("option label and value length", () => {
      reject([select({ options: [{ label: "", value: "a" }] })], "option label");
      reject([select({ options: [{ label: "x".repeat(101), value: "a" }] })], "option label");
      reject([select({ options: [{ label: "A", value: "" }] })], "option value");
      reject([select({ options: [{ label: "A", value: "v".repeat(101) }] })], "option value");
    });
    test("option description length", () => {
      const options = [{ label: "A", value: "a", description: "d".repeat(101) }];
      reject([select({ options })], "description");
    });
    test("placeholder length", () => {
      reject([select({ placeholder: "p".repeat(151) })], "placeholder");
      expect(() => validateRows([[select({ placeholder: "p".repeat(150) })]])).not.toThrow();
    });
    test("duplicate option values", () => {
      const options = [
        { label: "A", value: "a" },
        { label: "B", value: "a" },
      ];
      reject([select({ options })], "duplicate option value");
    });
    test("minValues is an integer 0-25", () => {
      reject([select({ minValues: -1 })], "minValues");
      reject([select({ minValues: 1.5 })], "minValues");
      expect(() => validateRows([[select({ minValues: 0 })]])).not.toThrow();
    });
    test("maxValues is an integer 1-25", () => {
      reject([select({ maxValues: 0 })], "maxValues");
      reject([select({ maxValues: 26 })], "maxValues");
      reject([select({ maxValues: 1.5 })], "maxValues");
    });
    test("minValues may not exceed maxValues", () => {
      reject([select({ minValues: 2, maxValues: 1 })], "do not fit");
    });
    test("link URL scheme", () => {
      for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x.test/"]) {
        reject([{ type: "link", url, label: "x" }], "http:");
      }
      for (const url of ["http://a.test", "https://a.test", "discord://-/channels/@me"]) {
        expect(() => validateRows([[{ type: "link", url, label: "x" }]])).not.toThrow();
      }
    });
    test("link URL length", () => {
      reject([{ type: "link", url: `https://a.test/${"x".repeat(500)}`, label: "x" }], "512");
    });
  });

  test("fake contexts apply the same validation to replies", async () => {
    const ctx = createFakeContext();
    await expect(ctx.reply({ components: [[]] })).rejects.toThrow("empty");
    const click = createFakeComponentContext();
    await expect(click.update({ components: [[]] })).rejects.toThrow("empty");
  });
});

describe("paginator", () => {
  const pages = ["a", "b", "c"];
  function setupPaginator(items = pages) {
    const seen: string[] = [];
    const paginator = createPaginator({
      module: "fun",
      name: "pages",
      render: ({ page, data, viewer }) => {
        seen.push(`${page}:${data}:${viewer.user.id}`);
        return { content: items[page] ?? "empty", pageCount: items.length };
      },
    });
    const registry = createRegistry([{ name: "fun", components: [paginator.button] }]);
    return { paginator, registry, seen };
  }
  const buttons = (reply: unknown) =>
    (reply as { components: ComponentRow[] }).components.at(-1) as Extract<
      ComponentRow[number],
      { type: "button" }
    >[];

  test("first page shows N/M with ◀ disabled", async () => {
    const { paginator } = setupPaginator();
    const reply = await paginator.first(createFakeContext(), "cat");
    const [prev, indicator, next] = buttons(reply);
    expect(reply.content).toBe("a");
    expect([prev?.label, indicator?.label, next?.label]).toEqual(["◀", "Strona 1/3", "▶"]);
    expect([prev?.disabled, indicator?.disabled, next?.disabled]).toEqual([true, true, false]);
  });

  test("▶ moves to the next page and ◀ comes back, with the arrows disabled at the ends", async () => {
    const { paginator, registry, seen } = setupPaginator();
    const first = await paginator.first(createFakeContext({ userId: OWNER }), "cat");
    const click1 = await clickComponent({ registry, customId: buttons(first)[2]?.customId ?? "" });
    expect(click1.updates[0]).toMatchObject({ content: "b" });
    const second = buttons(click1.updates[0]);
    expect(second.map((b) => b.disabled)).toEqual([false, true, false]);
    const click2 = await clickComponent({ registry, customId: second[2]?.customId ?? "" });
    const last = buttons(click2.updates[0]);
    expect(click2.updates[0]).toMatchObject({ content: "c" });
    expect(last.map((b) => b.disabled)).toEqual([false, true, true]);
    expect(last[1]?.label).toBe("Strona 3/3");
    const back = await clickComponent({ registry, customId: last[0]?.customId ?? "" });
    expect(back.updates[0]).toMatchObject({ content: "b" });
    expect(seen).toContain(`1:cat:${OWNER}`);
  });

  test("keeps the page components above the navigation row", async () => {
    const paginator = createPaginator({
      module: "fun",
      name: "pages",
      render: () => ({
        pageCount: 1,
        components: [[{ type: "link", url: "https://discord.com", label: "Link" }]],
      }),
    });
    const reply = await paginator.first(createFakeContext());
    expect(reply.components).toHaveLength(2);
    expect(buttons(reply).map((b) => b.disabled)).toEqual([true, true, true]);
  });

  test("another member cannot turn the page", async () => {
    const { paginator, registry } = setupPaginator();
    const first = await paginator.first(createFakeContext({ userId: OWNER }));
    const ctx = await clickComponent({
      registry,
      customId: buttons(first)[2]?.customId ?? "",
      userId: STRANGER,
    });
    expect(ctx.updates).toEqual([]);
    expect(ctx.replies).toEqual([{ content: NOT_YOUR_MENU, ephemeral: true }]);
  });

  test("a malformed button state is acknowledged instead of ignored", async () => {
    const { paginator, registry } = setupPaginator();
    const ctx = await clickComponent({
      registry,
      customId: paginator.button.customId(OWNER, "garbage"),
    });
    expect(ctx.updates).toEqual([]);
    expect(ctx.deferred).toBe(true);
  });

  test("permissions and guildOnly are checked on every click", async () => {
    const paginator = createPaginator({
      module: "fun",
      name: "pages",
      permissions: 1n << 5n,
      render: () => ({ content: "x", pageCount: 2 }),
    });
    const registry = createRegistry([{ name: "fun", components: [paginator.button] }]);
    const customId = paginator.button.customId(OWNER, "1:");
    const denied = await clickComponent({ registry, customId, memberPermissions: 0n });
    expect(denied.updates).toEqual([]);
    expect(denied.replies).toEqual([
      { content: "Nie masz uprawnień do tego menu.", ephemeral: true },
    ]);
    const allowed = await clickComponent({ registry, customId, memberPermissions: 1n << 5n });
    expect(allowed.updates).toHaveLength(1);

    const guildOnly = createPaginator({
      module: "fun",
      name: "pages",
      guildOnly: true,
      render: () => ({ content: "x", pageCount: 2 }),
    });
    const guildRegistry = createRegistry([{ name: "fun", components: [guildOnly.button] }]);
    const dm = await clickComponent({
      registry: guildRegistry,
      customId: guildOnly.button.customId(OWNER, "1:"),
      guildId: null,
    });
    expect(dm.replies).toEqual([{ content: "To menu działa tylko na serwerze.", ephemeral: true }]);
  });

  test("a page past the end after the list shrank falls back to the last page", async () => {
    const { paginator, registry } = setupPaginator(["only"]);
    const stale = paginator.button.customId(OWNER, "5:");
    const ctx = await clickComponent({ registry, customId: stale });
    expect(ctx.updates[0]).toMatchObject({ content: "only" });
    expect(buttons(ctx.updates[0])[1]?.label).toBe("Strona 1/1");
  });
});

describe("component state store", () => {
  function memory(now: () => number) {
    const entries = new Map<string, { value: string; expiresAt: number }>();
    return {
      async get(key: string) {
        const e = entries.get(key);
        return e && e.expiresAt > now() ? e.value : null;
      },
      async set(key: string, value: string, ttlMs?: number) {
        entries.set(key, { value, expiresAt: now() + (ttlMs ?? Infinity) });
      },
    };
  }

  test("round-trips state under a short key", async () => {
    const store = createComponentStateStore(
      memory(() => 0),
      { newKey: () => "k1" },
    );
    expect(await store.save({ items: [1, 2] })).toBe("k1");
    expect(await store.load("k1")).toEqual({ items: [1, 2] });
  });

  test("keeps state for 15 minutes, then reports the menu as expired", async () => {
    let clock = 0;
    const store = createComponentStateStore(
      memory(() => clock),
      { newKey: () => "k" },
    );
    await store.save("x");
    clock = 15 * 60_000 - 1;
    expect(await store.load("k")).toBe("x");
    clock = 15 * 60_000;
    await expect(store.load("k")).rejects.toThrow(ExpiredStateError);
    await expect(store.load("k")).rejects.toThrow(MENU_EXPIRED);
  });

  test("generated keys are 22 characters of base64url and differ", async () => {
    const store = createComponentStateStore(memory(() => 0));
    const keys = [await store.save(1), await store.save(2)];
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(STATE_KEY_LENGTH).toBe(22);
  });

  test("a prefix plus owner and a state key fits a custom_id", () => {
    const module = "m".repeat(MAX_COMPONENT_PREFIX - 2 - 32);
    const c = defineButton({ module, name: "x".repeat(32), run: async () => {} });
    const id = c.customId("9".repeat(20), "k".repeat(STATE_KEY_LENGTH));
    expect(id.length).toBeLessThanOrEqual(100);
  });

  test("an expired state reaches the user as an ephemeral message", async () => {
    const store = createComponentStateStore(memory(() => 0));
    const stateful = defineButton({
      module: "fun",
      name: "stateful",
      run: async (ctx) => {
        await store.load(ctx.state);
      },
    });
    const registry = createRegistry([{ name: "fun", components: [stateful] }]);
    const ctx = await clickComponent({ registry, customId: stateful.customId(OWNER, "gone") });
    expect(ctx.replies).toEqual([
      { content: "To menu wygasło. Wywołaj komendę jeszcze raz.", ephemeral: true },
    ]);
  });
});
