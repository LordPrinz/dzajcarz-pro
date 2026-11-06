import { describe, expect, test } from "bun:test";
import { defineCommand } from "./command.ts";
import { executeCommand, GENERIC_ERROR } from "./dispatch.ts";
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
