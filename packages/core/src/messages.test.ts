import { describe, expect, test } from "bun:test";
import { defineCommand, defineSubcommand } from "./command.ts";
import { checkAccess, executeCommand } from "./dispatch.ts";
import { UserError } from "./errors.ts";
import { fitLines, requireGuild } from "./helpers.ts";
import { silentLogger } from "./logger.ts";
import { common, coreMessages } from "./messages.ts";
import { defineModal, parseModalValues, validateModal } from "./modal.ts";
import { createPaginator } from "./paginator.ts";
import { parsePrefixArgs } from "./prefix.ts";
import { createRegistry } from "./registry.ts";
import { createFakeContext, renderCatalog, replyText } from "./testing/context.ts";

const loud = { pl: "głośno", en: "loud", de: "laut" };

describe("core texts in the caller's language", () => {
  test("a UserError written per language is shown in the caller's; message keeps the Polish", async () => {
    const error = new UserError((l) => ({ pl: "Nie", en: "No", de: "Nein" })[l]);
    expect(error.message).toBe("Nie");
    expect(error.messageIn("de")).toBe("Nein");
    expect(new UserError("Same").messageIn("en")).toBe("Same");

    const command = defineCommand({
      name: "x",
      description: "X",
      run: async () => {
        throw error;
      },
    });
    const ctx = createFakeContext({ locale: "en" });
    await executeCommand(command, ctx, silentLogger);
    expect(replyText(ctx.replies[0])).toBe("No");
  });

  test("the generic error, the guild-only and the permission refusals follow ctx.locale", async () => {
    const failing = defineCommand({
      name: "x",
      description: "X",
      run: async () => {
        throw new Error("boom");
      },
    });
    const ctx = createFakeContext({ locale: "de" });
    await executeCommand(failing, ctx, silentLogger);
    expect(replyText(ctx.replies[0])).toBe(
      "Etwas ist schiefgelaufen. Versuch es gleich noch einmal.",
    );
    const access = { guildId: null, memberPermissions: null, locale: "en" } as const;
    expect(checkAccess({ guildOnly: true }, access)).toBe("This command only works on a server.");
    expect(
      checkAccess({ permissions: 4n }, { ...access, guildId: "1", memberPermissions: 0n }),
    ).toBe("You don't have permission to use this command.");
    expect(() => requireGuild(null)).toThrow("Ta komenda działa tylko na serwerze.");
  });

  test("the prefix parser takes a choice by any language's name and answers in the given one", () => {
    const command = defineCommand({
      name: "volume",
      description: "V",
      options: {
        mode: {
          type: "string",
          description: "M",
          choices: [{ name: loud, value: "loud", aliases: ["glosno"] }],
          required: true,
        },
      },
      run: async () => {},
    });
    for (const word of ["laut", "LOUD", "głośno", "glosno", "loud"]) {
      expect(parsePrefixArgs(command, word)).toEqual({ ok: true, args: { mode: "loud" } });
    }
    expect(parsePrefixArgs(command, "", "en")).toEqual({
      ok: false,
      error: "Missing argument `mode`. Usage: `volume <mode>`",
    });
    expect(parsePrefixArgs(command, "a b", "de")).toEqual({
      ok: false,
      error: "Argument `mode`: erlaubt: loud",
    });
    const grouped = defineCommand({
      name: "queue",
      description: "Q",
      subcommands: { clear: defineSubcommand({ description: "C", run: async () => {} }) },
    });
    expect(parsePrefixArgs(grouped, "", "en")).toEqual({
      ok: false,
      error: "Pick a subcommand. Usage: `queue clear`",
    });
  });

  test("the registry checks every language's length and the choice words of every language", () => {
    const long = "x".repeat(101);
    const withDescription = (description: { pl: string; en: string; de: string }) =>
      createRegistry([
        { name: "m", commands: [defineCommand({ name: "a", description, run: async () => {} })] },
      ]);
    expect(() => withDescription({ pl: "ok", en: "ok", de: long })).toThrow("every language");
    const clash = defineCommand({
      name: "b",
      description: "B",
      options: {
        mode: {
          type: "string",
          description: "M",
          choices: [
            { name: loud, value: "loud" },
            { name: { pl: "cicho", en: "quiet", de: "laut" }, value: "quiet" },
          ],
        },
      },
      run: async () => {},
    });
    expect(() => createRegistry([{ name: "m", commands: [clash] }])).toThrow('Choice word "laut"');
  });

  test("modals validate every language and complain in the submitter's", () => {
    const fields = {
      name: { type: "short", label: { pl: "Imię", en: "Name", de: "Name" }, maxLength: 3 },
    } as const;
    expect(() => parseModalValues(fields, { name: "toolong" }, "en")).toThrow(
      "The field “Name” can be at most 3 characters long.",
    );
    expect(() => parseModalValues(fields, {}, "de")).toThrow("Das Feld „Name“ ist erforderlich.");
    const modal = defineModal({
      module: "m",
      name: "form",
      title: { pl: "Formularz", en: "Form", de: "x".repeat(46) },
      fields,
      run: async () => {},
    });
    expect(() => modal.build("1")).toThrow("title must be 1–45 characters");
    expect(() => validateModal({ customId: "m:f:1:", title: "T", fields: [] })).toThrow(
      "needs 1–5 fields",
    );
  });

  test("fitLines and the paginator speak the caller's language", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    expect(fitLines(lines, 100, "en")).toEndWith("… and 39 more");
    expect(fitLines(lines, 100)).toEndWith("… i jeszcze 39");
    const pager = createPaginator({
      module: "m",
      name: "p",
      render: () => ({ content: "x", pageCount: 2 }),
    });
    const page = await pager.first(createFakeContext({ locale: "de" }));
    const labels = (page.components ?? []).flat().map((c) => ("label" in c ? c.label : ""));
    expect(labels).toContain("Seite 1/2");
  });
});

test("every core text renders in every language", () => {
  for (const catalog of [renderCatalog(common), renderCatalog(coreMessages)]) {
    for (const texts of Object.values(catalog)) {
      for (const text of Object.values(texts)) expect(text.trim()).not.toBe("");
    }
  }
  expect(renderCatalog(coreMessages, { fieldLength: ["Name", 2, 5] }).en.fieldLength).toBe(
    "The field “Name” must be 2 to 5 characters long.",
  );
});
