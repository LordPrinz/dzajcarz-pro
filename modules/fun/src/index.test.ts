import { describe, expect, test } from "bun:test";
import { createRegistry, executeCommand, silentLogger } from "@dzajcarz/core";
import { createFakeContext, renderCatalog } from "@dzajcarz/core/testing";
import { createFunModule } from "./index.ts";
import { t } from "./messages.ts";

const WARSAW = "Europe/Warsaw";

function setup(options: { randoms?: number[]; now?: Date; guildZone?: string } = {}) {
  const randoms = [...(options.randoms ?? [])];
  const registry = createRegistry([
    createFunModule({
      random: () => {
        const next = randoms.shift();
        if (next === undefined) throw new Error("no queued random value");
        return next;
      },
      now: () => options.now ?? new Date("2026-07-01T10:00:00Z"),
      timeZones: {
        of: async (guildId) => (guildId !== null && options.guildZone) || WARSAW,
      },
    }),
  ]);
  const run = async (
    name: string,
    guildId: string | null = "100000000000000001",
    locale: "pl" | "en" | "de" = "pl",
  ) => {
    const command = registry.find(name);
    if (!command) throw new Error(`no command ${name}`);
    const ctx = createFakeContext({ guildId, locale });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies;
  };
  return { run, registry };
}

describe("czy_wiedziałeś", () => {
  test("below 0.5 the answer is 'Wiedział!' with a reaction", async () => {
    const { run } = setup({ randoms: [0.49] });
    expect(await run("czy_wiedziałeś")).toEqual([{ content: "Wiedział!", reactions: ["🙋‍♂️"] }]);
  });

  test("exactly 0.5 is 'Nie wiedział', without a reaction", async () => {
    const { run } = setup({ randoms: [0.5] });
    expect(await run("czy_wiedziałeś")).toEqual(["Nie wiedział sadge bruh"]);
  });

  test("the aliases without ł resolve to the command", () => {
    const { registry } = setup();
    const command = registry.find("czy_wiedziałeś");
    expect(command).toBeDefined();
    expect(registry.find("czy_wiedziales")).toBe(command);
    expect(registry.find("czywiedzial")).toBe(command);
  });
});

describe("time", () => {
  const timeAt = async (iso: string) => {
    const { run } = setup({ now: new Date(iso) });
    return run("time");
  };

  test("summer time is UTC+2", async () => {
    expect(await timeAt("2026-07-01T10:00:00Z")).toEqual(["Jest 12:00:00."]);
  });

  test("winter time is UTC+1", async () => {
    expect(await timeAt("2026-01-01T10:00:00Z")).toEqual(["Jest 11:00:00."]);
  });

  test("midnight in Warsaw is 00, never 24", async () => {
    expect(await timeAt("2026-01-01T23:00:00Z")).toEqual(["Jest 00:00:00."]);
    expect(await timeAt("2026-01-01T22:59:59Z")).toEqual(["Jest 23:59:59."]);
  });

  test("the offset jumps at the DST changes", async () => {
    // 2026-03-29 01:00 UTC: 02:00 CET becomes 03:00 CEST.
    expect(await timeAt("2026-03-29T00:59:59Z")).toEqual(["Jest 01:59:59."]);
    expect(await timeAt("2026-03-29T01:00:00Z")).toEqual(["Jest 03:00:00."]);
    // 2026-10-25 01:00 UTC: 03:00 CEST falls back to 02:00 CET.
    expect(await timeAt("2026-10-25T00:59:59Z")).toEqual(["Jest 02:59:59."]);
    expect(await timeAt("2026-10-25T01:00:00Z")).toEqual(["Jest 02:00:00."]);
  });
});

describe("time in the server's zone", () => {
  test("a server with its own zone gets its clock; a DM gets the default", async () => {
    const { run } = setup({ now: new Date("2026-07-01T10:00:00Z"), guildZone: "Asia/Tokyo" });
    expect(await run("time")).toEqual(["Jest 19:00:00."]);
    expect(await run("time", null)).toEqual(["Jest 12:00:00."]);
  });
});

describe("languages", () => {
  test("czy_wiedziałeś answers in English and German", async () => {
    const { run } = setup({ randoms: [0.1, 0.9, 0.1, 0.9] });
    expect(await run("czy_wiedziałeś", undefined, "en")).toEqual([
      { content: "He knew!", reactions: ["🙋‍♂️"] },
    ]);
    expect(await run("czy_wiedziałeś", undefined, "en")).toEqual(["He didn't know sadge bruh"]);
    expect(await run("czy_wiedziałeś", undefined, "de")).toEqual([
      { content: "Er wusste es!", reactions: ["🙋‍♂️"] },
    ]);
    expect(await run("czy_wiedziałeś", undefined, "de")).toEqual([
      "Er wusste es nicht, sadge bruh",
    ]);
  });

  test("time speaks English and German", async () => {
    const { run } = setup();
    expect(await run("time", undefined, "en")).toEqual(["It is 12:00:00."]);
    expect(await run("time", undefined, "de")).toEqual(["Es ist 12:00:00."]);
  });

  test("every catalog text is filled in", () => {
    for (const texts of Object.values(renderCatalog(t))) {
      for (const s of Object.values(texts)) expect(s.trim()).not.toBe("");
    }
  });
});
