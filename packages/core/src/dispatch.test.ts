import { describe, expect, test } from "bun:test";
import { defineCommand, defineSubcommand } from "./command.ts";
import { checkAccess, executeCommand, GENERIC_ERROR } from "./dispatch.ts";
import { UserError } from "./errors.ts";
import { createJsonLogger, silentLogger } from "./logger.ts";
import { createFakeContext, replyText } from "./testing/context.ts";

const BAN = 1n << 2n;

describe("executeCommand", () => {
  test("runs the command with the context", async () => {
    const command = defineCommand({
      name: "echo",
      description: "Echo",
      options: { text: { type: "string", description: "Text", required: true } },
      run: async (ctx) => ctx.reply(ctx.args.text),
    });
    const ctx = createFakeContext({ args: { text: "hej" } });
    await executeCommand(command, ctx, silentLogger);
    expect(ctx.replies).toEqual(["hej"]);
  });

  test("shows a UserError message to the caller only", async () => {
    const command = defineCommand({
      name: "fail",
      description: "Fail",
      run: async () => {
        throw new UserError("Wejdź na kanał głosowy.");
      },
    });
    const ctx = createFakeContext();
    await executeCommand(command, ctx, silentLogger);
    expect(ctx.replies).toEqual([{ content: "Wejdź na kanał głosowy.", ephemeral: true }]);
  });

  test("logs an unexpected error and hides its message", async () => {
    const lines: string[] = [];
    const command = defineCommand({
      name: "crash",
      description: "Crash",
      run: async () => {
        throw new Error("database password is hunter2");
      },
    });
    const ctx = createFakeContext();
    await executeCommand(command, ctx, createJsonLogger({ write: (line) => lines.push(line) }));
    expect(replyText(ctx.replies[0])).toBe(GENERIC_ERROR);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({ level: "error", command: "crash", invocation: "slash" });
    expect(entry.error.message).toBe("database password is hunter2");
  });

  test("refuses guild-only commands in direct messages", async () => {
    let ran = false;
    const command = defineCommand({
      name: "party",
      description: "Party",
      guildOnly: true,
      run: async () => {
        ran = true;
      },
    });
    const ctx = createFakeContext({ guildId: null });
    await executeCommand(command, ctx, silentLogger);
    expect(ran).toBe(false);
    expect(replyText(ctx.replies[0])).toBe("Ta komenda działa tylko na serwerze.");
  });

  test("checks member permissions, which matters for prefix commands", async () => {
    let runs = 0;
    const command = defineCommand({
      name: "ban",
      description: "Ban",
      permissions: BAN,
      run: async () => {
        runs++;
      },
    });
    const denied = createFakeContext({ invocation: "prefix", memberPermissions: 1n });
    await executeCommand(command, denied, silentLogger);
    expect(replyText(denied.replies[0])).toBe("Nie masz uprawnień do tej komendy.");

    await executeCommand(command, createFakeContext({ memberPermissions: BAN | 1n }), silentLogger);
    expect(runs).toBe(1);
  });

  test("survives a failing error reply", async () => {
    const command = defineCommand({
      name: "x",
      description: "X",
      run: async () => {
        throw new Error("boom");
      },
    });
    const ctx = createFakeContext();
    ctx.reply = async () => {
      throw new Error("Unknown interaction");
    };
    await expect(executeCommand(command, ctx, silentLogger)).resolves.toBeUndefined();
  });
});

test("administrators pass every permission check", async () => {
  let ran = false;
  const command = defineCommand({
    name: "ban",
    description: "Ban",
    permissions: BAN,
    run: async () => {
      ran = true;
    },
  });
  await executeCommand(command, createFakeContext({ memberPermissions: 1n << 3n }), silentLogger);
  expect(ran).toBe(true);
});

describe("executeCommand with subcommands", () => {
  const MANAGE = 1n << 5n;
  const ran: string[] = [];
  const command = defineCommand({
    name: "prefix",
    description: "Prefix",
    permissions: 1n << 1n,
    subcommands: {
      show: defineSubcommand({ description: "Show", run: async () => void ran.push("show") }),
      set: defineSubcommand({
        description: "Set",
        permissions: MANAGE,
        options: { value: { type: "string", description: "v", required: true } },
        run: async (ctx) => void ran.push(`set ${ctx.args.value}`),
      }),
    },
  });
  const KICK = 1n << 1n;

  test("runs the chosen subcommand with its arguments", async () => {
    ran.length = 0;
    const ctx = createFakeContext({
      subcommand: "set",
      args: { value: "?" },
      memberPermissions: KICK | MANAGE,
    });
    await executeCommand(command, ctx, silentLogger);
    expect(ran).toEqual(["set ?"]);
  });

  test("checks the command permissions, then the subcommand's own", async () => {
    ran.length = 0;
    const noCommandPermission = createFakeContext({ subcommand: "show", memberPermissions: 0n });
    await executeCommand(command, noCommandPermission, silentLogger);
    expect(replyText(noCommandPermission.replies[0])).toBe("Nie masz uprawnień do tej komendy.");

    const noSubPermission = createFakeContext({ subcommand: "set", memberPermissions: KICK });
    await executeCommand(command, noSubPermission, silentLogger);
    expect(replyText(noSubPermission.replies[0])).toBe("Nie masz uprawnień do tej komendy.");

    await executeCommand(
      command,
      createFakeContext({ subcommand: "show", memberPermissions: KICK }),
      silentLogger,
    );
    expect(ran).toEqual(["show"]);
  });

  test("administrators skip the subcommand permission too", async () => {
    ran.length = 0;
    const ctx = createFakeContext({
      subcommand: "set",
      args: { value: "x" },
      memberPermissions: 1n << 3n,
    });
    await executeCommand(command, ctx, silentLogger);
    expect(ran).toEqual(["set x"]);
  });

  test("refuses a subcommand with permissions in direct messages", async () => {
    const open = defineCommand({
      name: "x",
      description: "X",
      subcommands: { a: defineSubcommand({ description: "A", permissions: MANAGE, run: noRun }) },
    });
    const ctx = createFakeContext({ subcommand: "a", guildId: null });
    await executeCommand(open, ctx, silentLogger);
    expect(replyText(ctx.replies[0])).toBe("Ta komenda działa tylko na serwerze.");
  });

  test("a missing or unknown subcommand gets a Polish error", async () => {
    for (const subcommand of [undefined, "nope"]) {
      const ctx = createFakeContext({ subcommand, memberPermissions: KICK });
      await executeCommand(command, ctx, silentLogger);
      expect(replyText(ctx.replies[0])).toBe("Nieznana podkomenda. Użycie: `prefix show|set`");
    }
  });
});

async function noRun() {}

describe("checkAccess", () => {
  test("lets a command without restrictions through, in a DM too", () => {
    expect(checkAccess({}, { guildId: null, memberPermissions: null })).toBeNull();
  });

  test("refuses guild-only and permissioned commands in a DM", () => {
    const message = "Ta komenda działa tylko na serwerze.";
    expect(checkAccess({ guildOnly: true }, { guildId: null, memberPermissions: null })).toBe(
      message,
    );
    expect(checkAccess({ permissions: BAN }, { guildId: null, memberPermissions: null })).toBe(
      message,
    );
  });

  test("refuses a member without the permission and lets administrators through", () => {
    const guildId = "1";
    expect(checkAccess({ permissions: BAN }, { guildId, memberPermissions: 0n })).toBe(
      "Nie masz uprawnień do tej komendy.",
    );
    expect(checkAccess({ permissions: BAN }, { guildId, memberPermissions: BAN })).toBeNull();
    expect(checkAccess({ permissions: BAN }, { guildId, memberPermissions: 1n << 3n })).toBeNull();
  });
});
