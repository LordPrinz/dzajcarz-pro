import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type Invocation,
  type Logger,
  type Reply,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import {
  BOT_TARGET,
  HIGHER_THAN_ACTOR,
  HIGHER_THAN_BOT,
  OWNER_TARGET,
  SELF_TARGET,
} from "./hierarchy.ts";
import {
  ADMIN_TIMEOUT,
  BAD_DURATION,
  BOT_LACKS_PERMISSION,
  createModerationModule,
  type MemberInfo,
  type ModerationEntry,
  type ModerationGuild,
  type ModerationLog,
  NO_GUILD_PERMISSION,
  NOT_A_MEMBER,
  NOT_RECORDED,
  NOT_TIMED_OUT,
  type PurgeResult,
  REASON_TOO_LONG,
  WARN_DM_WINDOW_MS,
  WARNINGS_DM_CLOSED,
  WARNINGS_SENT,
  type WarningRecord,
} from "./index.ts";

const GUILD = "100000000000000001";
const CALLER = "200000000000000002";
const CHANNEL = "300000000000000003";
const BOT = "400000000000000004";
const TARGET = "500000000000000005";
const STRANGER = "600000000000000006";

const KICK = 1n << 1n;
const BAN = 1n << 2n;
const ADMIN = 1n << 3n;
const MANAGE_MESSAGES = 1n << 13n;
const MODERATE = 1n << 40n;
const ALL = KICK | BAN | MANAGE_MESSAGES | MODERATE;

function member(id: string, topRole: number, extra: Partial<MemberInfo> = {}): MemberInfo {
  return { id, topRole, isOwner: false, permissions: 0n, timedOut: false, ...extra };
}

type Call =
  | { kind: "ban" | "kick" | "untimeout"; userId: string; reason: string }
  | { kind: "timeout"; userId: string; ms: number; reason: string }
  | { kind: "purge"; channelId: string; count: number; skipNewest: number }
  | { kind: "dm"; userId: string; text: string };

interface FakeGuildOptions {
  members?: MemberInfo[];
  /** The direct message rejects (network, unknown user). */
  dmFails?: boolean;
  /** The direct message is refused (`sendDirect` returns false). */
  dmClosed?: boolean;
  /** Discord refuses ban and kick after the checks passed. */
  actionFails?: boolean;
  purgeResult?: Partial<PurgeResult>;
}

function fakeGuild({
  members = [],
  dmFails = false,
  dmClosed = false,
  actionFails = false,
  purgeResult = {},
}: FakeGuildOptions = {}) {
  const calls: Call[] = [];
  const byId = new Map<string, MemberInfo>(
    [
      member(CALLER, 10, { permissions: ALL }),
      member(BOT, 20, { permissions: ALL }),
      member(TARGET, 5),
      ...members,
    ].map((info) => [info.id, info]),
  );
  const refuse = () => {
    if (actionFails) throw new Error("Missing Permissions");
  };
  const guild: ModerationGuild = {
    async member(_guildId, userId) {
      return byId.get(userId) ?? null;
    },
    async self() {
      return byId.get(BOT) as MemberInfo;
    },
    async guildName() {
      return "Dżajcownia";
    },
    async ban(_guildId, userId, reason) {
      refuse();
      calls.push({ kind: "ban", userId, reason });
    },
    async kick(_guildId, userId, reason) {
      refuse();
      calls.push({ kind: "kick", userId, reason });
    },
    async timeout(_guildId, userId, ms, reason) {
      calls.push({ kind: "timeout", userId, ms, reason });
    },
    async untimeout(_guildId, userId, reason) {
      calls.push({ kind: "untimeout", userId, reason });
    },
    async purge(channelId, count, skipNewest) {
      calls.push({ kind: "purge", channelId, count, skipNewest });
      return { deleted: 3, tooOld: 0, pinned: 0, ...purgeResult };
    },
    async sendDirect(userId, text) {
      if (dmFails) throw new Error("Cannot send messages to this user");
      calls.push({ kind: "dm", userId, text });
      return !dmClosed;
    },
  };
  return { guild, calls };
}

function fakeLog({ fails = false, warnings = [] as WarningRecord[] } = {}) {
  const entries: ModerationEntry[] = [];
  const log: ModerationLog = {
    async record(entry) {
      if (fails) throw new Error("db down");
      entries.push(entry);
      return { id: entries.length };
    },
    async warnings(guildId, userId, limit) {
      const stored = entries.filter(
        (entry) =>
          entry.guildId === guildId && entry.targetId === userId && entry.action === "warn",
      );
      return {
        total: warnings.length + stored.length,
        recent: warnings.slice(0, limit),
      };
    },
  };
  return { log, entries };
}

function capturingLogger() {
  const lines: { level: string; message: string }[] = [];
  const logger: Logger = {
    debug: (message) => void lines.push({ level: "debug", message }),
    info: (message) => void lines.push({ level: "info", message }),
    warn: (message) => void lines.push({ level: "warn", message }),
    error: (message) => void lines.push({ level: "error", message }),
    child: () => logger,
  };
  return { logger, lines };
}

interface RunOptions {
  invocation?: Invocation;
  memberPermissions?: bigint;
}

function setup(
  guildOptions: FakeGuildOptions = {},
  logOptions = {},
  dmLimit: Pick<KeyValueStore, "setIfAbsent"> = createMemoryStore(),
) {
  const { guild, calls } = fakeGuild(guildOptions);
  const { log, entries } = fakeLog(logOptions);
  const { logger, lines } = capturingLogger();
  const timeZones = { of: async () => "Europe/Warsaw" };
  const registry = createRegistry([
    createModerationModule({ guild, log, dmLimit, timeZones, logger }),
  ]);
  async function run(
    name: string,
    args: Record<string, unknown>,
    { invocation = "slash", memberPermissions = ALL }: RunOptions = {},
  ) {
    const command = registry.find(name);
    if (!command) throw new Error(`no command ${name}`);
    const ctx = createFakeContext({ args, invocation, memberPermissions, userId: CALLER });
    await executeCommand(command, ctx, silentLogger);
    return ctx;
  }
  return { run, calls, entries, lines, registry };
}

const text = (replies: Reply[]) => replyText(replies.at(-1));
const isEphemeral = (reply: Reply | undefined) => typeof reply === "object" && reply.ephemeral;

describe("ban", () => {
  test("bans with the audit reason, DMs the member first and records the action", async () => {
    const { run, calls, entries } = setup();
    const ctx = await run("ban", { user: TARGET, reason: "spam" });
    expect(calls).toEqual([
      { kind: "dm", userId: TARGET, text: "Ban na serwerze Dżajcownia. Powód: spam" },
      { kind: "ban", userId: TARGET, reason: "tester: spam" },
    ]);
    expect(entries).toEqual([
      {
        guildId: GUILD,
        action: "ban",
        moderatorId: CALLER,
        targetId: TARGET,
        channelId: null,
        reason: "spam",
        durationMs: null,
        messageCount: null,
      },
    ]);
    expect(ctx.deferred).toBe(true);
    expect(text(ctx.replies)).toBe(`Zbanowano <@${TARGET}>. Powód: spam`);
  });

  test("a user who is not a member is banned by id, without a DM", async () => {
    const { run, calls, entries } = setup();
    await run("ban", { user: STRANGER });
    expect(calls).toEqual([{ kind: "ban", userId: STRANGER, reason: "tester: brak powodu" }]);
    expect(entries[0]?.targetId).toBe(STRANGER);
    expect(entries[0]?.reason).toBeNull();
  });

  test("a failed DM never stops the ban", async () => {
    const { run, calls, lines } = setup({ dmFails: true });
    const ctx = await run("ban", { user: TARGET });
    expect(calls).toEqual([{ kind: "ban", userId: TARGET, reason: "tester: brak powodu" }]);
    expect(lines.some((line) => line.level === "warn")).toBe(true);
    expect(text(ctx.replies)).toBe(`Zbanowano <@${TARGET}>. Powód: brak powodu`);
  });

  test("a ban Discord refuses after the DM sends a correction and records nothing", async () => {
    const { run, calls, entries } = setup({ actionFails: true });
    await run("ban", { user: TARGET });
    expect(calls).toEqual([
      { kind: "dm", userId: TARGET, text: "Ban na serwerze Dżajcownia. Powód: brak powodu" },
      { kind: "dm", userId: TARGET, text: "Ban na serwerze Dżajcownia nie doszedł do skutku." },
    ]);
    expect(entries).toEqual([]);
  });
});

describe("kick", () => {
  test("kicks a member after the DM and records it", async () => {
    const { run, calls, entries } = setup();
    const ctx = await run("kick", { user: TARGET, reason: "flood" });
    expect(calls).toEqual([
      { kind: "dm", userId: TARGET, text: "Wyrzucenie z serwera Dżajcownia. Powód: flood" },
      { kind: "kick", userId: TARGET, reason: "tester: flood" },
    ]);
    expect(entries.map((entry) => entry.action)).toEqual(["kick"]);
    expect(text(ctx.replies)).toBe(`Wyrzucono <@${TARGET}>. Powód: flood`);
  });

  test("someone who is not a member cannot be kicked", async () => {
    const { run, calls, entries } = setup();
    const ctx = await run("kick", { user: STRANGER });
    expect(text(ctx.replies)).toBe(NOT_A_MEMBER);
    expect(calls).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("a closed DM is logged quietly and the kick goes ahead", async () => {
    const { run, calls } = setup({ dmClosed: true });
    await run("kick", { user: TARGET });
    expect(calls.map((call) => call.kind)).toEqual(["dm", "kick"]);
  });

  test("a kick Discord refuses after the DM sends a correction", async () => {
    const { run, calls } = setup({ actionFails: true });
    await run("kick", { user: TARGET });
    expect(calls.at(-1)).toEqual({
      kind: "dm",
      userId: TARGET,
      text: "Wyrzucenie z serwera Dżajcownia nie doszło do skutku.",
    });
  });

  test("no correction goes out when the first DM did not", async () => {
    const { run, calls } = setup({ actionFails: true, dmClosed: true });
    await run("kick", { user: TARGET });
    expect(calls.filter((call) => call.kind === "dm")).toHaveLength(1);
  });
});

describe("timeout", () => {
  test("times out for the parsed duration, then DMs the duration and the reason", async () => {
    const { run, calls, entries } = setup();
    const ctx = await run("timeout", { user: TARGET, duration: "2h", reason: "spokój" });
    expect(calls).toEqual([
      { kind: "timeout", userId: TARGET, ms: 7_200_000, reason: "tester: spokój" },
      {
        kind: "dm",
        userId: TARGET,
        text: "Wyciszenie na serwerze Dżajcownia na 2 h. Powód: spokój",
      },
    ]);
    expect(entries[0]).toMatchObject({ action: "timeout", durationMs: 7_200_000 });
    expect(text(ctx.replies)).toBe(`Wyciszono <@${TARGET}> na 2 h. Powód: spokój`);
  });

  test("a bad or too long duration is refused before anything happens", async () => {
    for (const duration of ["29d", "0s", "1w", "10"]) {
      const { run, calls, entries } = setup();
      const ctx = await run("timeout", { user: TARGET, duration });
      expect(text(ctx.replies)).toBe(BAD_DURATION);
      expect(ctx.deferred).toBe(false);
      expect(calls).toEqual([]);
      expect(entries).toEqual([]);
    }
  });

  test("28 days is accepted", async () => {
    const { run, calls } = setup();
    await run("timeout", { user: TARGET, duration: "28d" });
    expect(calls[0]).toMatchObject({ kind: "timeout", ms: 28 * 86_400_000 });
  });

  test("an administrator cannot be timed out", async () => {
    const { run, calls } = setup({ members: [member(TARGET, 5, { permissions: ADMIN })] });
    const ctx = await run("timeout", { user: TARGET, duration: "1m" });
    expect(text(ctx.replies)).toBe(ADMIN_TIMEOUT);
    expect(ctx.deferred).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a failed DM never stops the timeout", async () => {
    const { run, calls, entries } = setup({ dmFails: true });
    await run("timeout", { user: TARGET, duration: "10m" });
    expect(calls.map((call) => call.kind)).toEqual(["timeout"]);
    expect(entries).toHaveLength(1);
  });
});

describe("untimeout", () => {
  test("lifts a running timeout and records it", async () => {
    const { run, calls, entries } = setup({ members: [member(TARGET, 5, { timedOut: true })] });
    const ctx = await run("untimeout", { user: TARGET, reason: "przeprosił" });
    expect(calls).toEqual([{ kind: "untimeout", userId: TARGET, reason: "tester: przeprosił" }]);
    expect(entries[0]).toMatchObject({ action: "untimeout", targetId: TARGET, durationMs: null });
    expect(text(ctx.replies)).toBe(`Zdjęto wyciszenie z <@${TARGET}>. Powód: przeprosił`);
  });

  test("a member without a timeout is told so and nothing is recorded", async () => {
    const { run, calls, entries } = setup();
    const ctx = await run("untimeout", { user: TARGET });
    expect(text(ctx.replies)).toBe(NOT_TIMED_OUT);
    expect(calls).toEqual([]);
    expect(entries).toEqual([]);
  });
});

describe("warn", () => {
  test("records the warning, shows its number and DMs the member", async () => {
    const earlier: WarningRecord = {
      id: 1,
      moderatorId: CALLER,
      reason: "x",
      createdAt: new Date(),
    };
    const { run, calls, entries } = setup({}, { warnings: [earlier] });
    const ctx = await run("warn", { user: TARGET, reason: "bez spamu" });
    expect(entries[0]).toMatchObject({ action: "warn", targetId: TARGET, reason: "bez spamu" });
    expect(calls).toEqual([
      { kind: "dm", userId: TARGET, text: "Ostrzeżenie na serwerze Dżajcownia. Powód: bez spamu" },
    ]);
    expect(text(ctx.replies)).toBe(
      `Ostrzeżenie dla <@${TARGET}> (ostrzeżenie nr 2). Powód: bez spamu`,
    );
  });

  test("a failed record still confirms the warning, without a number and with the note", async () => {
    const { run, lines } = setup({}, { fails: true });
    const ctx = await run("warn", { user: TARGET });
    expect(text(ctx.replies)).toBe(
      `Ostrzeżenie dla <@${TARGET}>. Powód: brak powodu${NOT_RECORDED}`,
    );
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  test("a failed DM never stops the warning", async () => {
    const { run, entries } = setup({ dmFails: true });
    const ctx = await run("warn", { user: TARGET });
    expect(entries).toHaveLength(1);
    expect(text(ctx.replies)).toContain("(ostrzeżenie nr 1)");
  });

  test("only one warning DM per member every 10 minutes; every warning is recorded", async () => {
    let now = 0;
    const store = createMemoryStore(() => now);
    const { run, calls, entries } = setup({}, {}, store);
    await run("warn", { user: TARGET, reason: "1" });
    await run("warn", { user: TARGET, reason: "2" });
    now += WARN_DM_WINDOW_MS - 1;
    await run("warn", { user: TARGET, reason: "3" });
    now += 1;
    await run("warn", { user: TARGET, reason: "4" });
    expect(entries).toHaveLength(4);
    expect(
      calls.filter((call) => call.kind === "dm").map((call) => call.kind === "dm" && call.text),
    ).toEqual([
      "Ostrzeżenie na serwerze Dżajcownia. Powód: 1",
      "Ostrzeżenie na serwerze Dżajcownia. Powód: 4",
    ]);
  });

  test("a failing limit store still sends the DM and logs", async () => {
    const broken: Pick<KeyValueStore, "setIfAbsent"> = {
      setIfAbsent: async () => {
        throw new Error("redis down");
      },
    };
    const { run, calls, lines } = setup({}, {}, broken);
    await run("warn", { user: TARGET });
    expect(calls.map((call) => call.kind)).toEqual(["dm"]);
    expect(lines.some((line) => line.level === "warn")).toBe(true);
  });
});

describe("hierarchy refusals", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["ban", {}],
    ["kick", {}],
    ["timeout", { duration: "10m" }],
    ["untimeout", {}],
    ["warn", {}],
  ];

  test("each action refuses the caller, the owner and equal or higher roles", async () => {
    const refusals: [MemberInfo, string][] = [
      [member(TARGET, 0, { isOwner: true, timedOut: true }), OWNER_TARGET],
      [member(TARGET, 10, { timedOut: true }), HIGHER_THAN_ACTOR],
      [member(TARGET, 15, { timedOut: true }), HIGHER_THAN_ACTOR],
    ];
    for (const [name, args] of cases) {
      for (const [target, message] of refusals) {
        const { run, calls, entries } = setup({ members: [target] });
        const ctx = await run(name, { ...args, user: TARGET });
        expect(text(ctx.replies)).toBe(message);
        expect(isEphemeral(ctx.replies[0])).toBe(true);
        expect(ctx.deferred).toBe(false);
        expect(calls).toEqual([]);
        expect(entries).toEqual([]);
      }
      const self = setup();
      expect(text((await self.run(name, { ...args, user: CALLER })).replies)).toBe(SELF_TARGET);
      expect(self.calls).toEqual([]);
    }
  });

  test("a target at or above the bot's role is refused, even when the owner asks", async () => {
    const owner = member(CALLER, 0, { isOwner: true, permissions: ALL });
    const { run, calls } = setup({ members: [owner, member(TARGET, 25)] });
    const ctx = await run("ban", { user: TARGET });
    expect(text(ctx.replies)).toBe(HIGHER_THAN_BOT);
    expect(calls).toEqual([]);
  });

  test("the bot itself cannot be targeted", async () => {
    const { run, calls } = setup();
    const ctx = await run("kick", { user: BOT });
    expect(text(ctx.replies)).toBe(BOT_TARGET);
    expect(calls).toEqual([]);
  });
});

describe("permissions", () => {
  test("the dispatcher refuses a member without the bit, slash and prefix alike", async () => {
    const required: [string, Record<string, unknown>][] = [
      ["ban", { user: TARGET }],
      ["kick", { user: TARGET }],
      ["timeout", { user: TARGET, duration: "1m" }],
      ["untimeout", { user: TARGET }],
      ["warn", { user: TARGET }],
      ["warnings", { user: TARGET }],
      ["purge", { count: 5 }],
    ];
    for (const [name, args] of required) {
      for (const invocation of ["slash", "prefix"] as const) {
        const { run, calls, entries } = setup();
        const ctx = await run(name, args, { invocation, memberPermissions: 0n });
        expect(text(ctx.replies)).toBe("Nie masz uprawnień do tej komendy.");
        expect(calls).toEqual([]);
        expect(entries).toEqual([]);
      }
    }
  });

  test("each command declares its Discord permission", async () => {
    const { registry } = setup();
    const declared = Object.fromEntries(
      registry.commands().map((command) => [command.name, command.permissions]),
    );
    expect(declared).toEqual({
      ban: BAN,
      kick: KICK,
      timeout: MODERATE,
      untimeout: MODERATE,
      warn: MODERATE,
      warnings: MODERATE,
      purge: MANAGE_MESSAGES,
    });
  });

  test("a channel overwrite is not enough: member actions need the guild-level permission", async () => {
    // The member passes the dispatcher (channel permissions grant everything) but their roles do not.
    const channelOnly = member(CALLER, 10, { permissions: MANAGE_MESSAGES });
    const actions: [string, Record<string, unknown>][] = [
      ["ban", { user: TARGET }],
      ["kick", { user: TARGET }],
      ["timeout", { user: TARGET, duration: "1m" }],
      ["untimeout", { user: TARGET }],
      ["warn", { user: TARGET }],
      ["warnings", { user: TARGET }],
    ];
    for (const [name, args] of actions) {
      const { run, calls, entries } = setup({ members: [channelOnly] });
      const ctx = await run(name, args);
      expect(text(ctx.replies)).toBe(NO_GUILD_PERMISSION);
      expect(calls).toEqual([]);
      expect(entries).toEqual([]);
    }
  });

  test("an administrator passes the guild-level check without the bit itself", async () => {
    const admin = member(CALLER, 10, { permissions: ADMIN });
    const { run, calls } = setup({ members: [admin] });
    await run("kick", { user: TARGET }, { memberPermissions: ADMIN });
    expect(calls.map((call) => call.kind)).toEqual(["dm", "kick"]);
  });

  test("a bot without the permission refuses before deferring, so no DM goes out", async () => {
    const powerless = member(BOT, 20, { permissions: 0n });
    const timedOut = member(TARGET, 5, { timedOut: true });
    for (const [name, args] of [
      ["ban", {}],
      ["kick", {}],
      ["timeout", { duration: "1m" }],
      ["untimeout", {}],
    ] as const) {
      const { run, calls, entries } = setup({ members: [powerless, timedOut] });
      const ctx = await run(name, { ...args, user: TARGET });
      expect(text(ctx.replies)).toBe(BOT_LACKS_PERMISSION);
      expect(ctx.deferred).toBe(false);
      expect(calls).toEqual([]);
      expect(entries).toEqual([]);
    }
  });

  test("an administrator bot may act; warn needs nothing from the bot", async () => {
    const adminBot = setup({ members: [member(BOT, 20, { permissions: ADMIN })] });
    await adminBot.run("ban", { user: TARGET });
    expect(adminBot.calls.map((call) => call.kind)).toEqual(["dm", "ban"]);
    const powerless = setup({ members: [member(BOT, 20, { permissions: 0n })] });
    await powerless.run("warn", { user: TARGET });
    expect(powerless.entries).toHaveLength(1);
  });
});

describe("reasons", () => {
  test("a reason is echoed as typed; mentions inside it are left to NO_MENTIONS", async () => {
    const reason = "@everyone <@&123456789012345678> <@600000000000000006> **głośno**";
    const { run, calls } = setup();
    const ctx = await run("ban", { user: TARGET, reason });
    expect(text(ctx.replies)).toBe(`Zbanowano <@${TARGET}>. Powód: ${reason}`);
    expect(calls.find((call) => call.kind === "ban")).toMatchObject({
      reason: `tester: ${reason}`,
    });
  });

  test("512 characters are fine, 513 are refused before anything happens", async () => {
    const ok = setup();
    await ok.run("warn", { user: TARGET, reason: "a".repeat(512) });
    expect(ok.entries[0]?.reason).toHaveLength(512);

    const { run, calls, entries } = setup();
    const ctx = await run("ban", { user: TARGET, reason: "a".repeat(513) });
    expect(text(ctx.replies)).toBe(REASON_TOO_LONG);
    expect(calls).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("the audit reason with the moderator's name in front stays within 512 characters", async () => {
    const { run, calls } = setup();
    await run("kick", { user: TARGET, reason: "ż".repeat(512) });
    const kick = calls.find((call) => call.kind === "kick");
    expect(kick && "reason" in kick ? [...kick.reason].length : 0).toBe(512);
  });

  test("an empty reason counts as none", async () => {
    const { run, entries } = setup();
    await run("warn", { user: TARGET, reason: "   " });
    expect(entries[0]?.reason).toBeNull();
  });
});

describe("history failures", () => {
  test("a failed record keeps the action and appends the note to the reply", async () => {
    for (const [name, args] of [
      ["ban", {}],
      ["kick", {}],
      ["timeout", { duration: "5m" }],
    ] as const) {
      const { run, calls, lines } = setup({}, { fails: true });
      const ctx = await run(name, { ...args, user: TARGET });
      expect(calls.some((call) => call.kind === name)).toBe(true);
      expect(text(ctx.replies)?.endsWith(NOT_RECORDED)).toBe(true);
      expect(lines.some((line) => line.level === "error")).toBe(true);
    }
  });
});

describe("warnings", () => {
  const at = new Date("2026-07-01T12:05:00Z");

  test("lists the newest warnings in Warsaw time, only to the caller", async () => {
    const records: WarningRecord[] = [
      { id: 7, moderatorId: CALLER, reason: "drugie", createdAt: at },
      { id: 3, moderatorId: BOT, reason: null, createdAt: new Date("2026-01-15T23:30:00Z") },
    ];
    const { run, calls } = setup({}, { warnings: records });
    const ctx = await run("warnings", { user: TARGET });
    expect(ctx.deferOptions).toEqual({ ephemeral: true });
    expect(isEphemeral(ctx.replies[0])).toBe(true);
    expect(text(ctx.replies)).toBe(
      [
        `<@${TARGET}> ma 2 ostrzeżenia:`,
        `\`#7\` 01.07.2026 14:05 od <@${CALLER}>: drugie`,
        `\`#3\` 16.01.2026 00:30 od <@${BOT}>: brak powodu`,
      ].join("\n"),
    );
    expect(calls).toEqual([]);
  });

  test("a member without warnings gets a short answer", async () => {
    const { run } = setup();
    const ctx = await run("warnings", { user: TARGET });
    expect(text(ctx.replies)).toBe(`<@${TARGET}> nie ma ostrzeżeń.`);
  });

  test("25 warnings with 512-character reasons: ten shown, each cut to 120, in one message", async () => {
    const records = Array.from(
      { length: 25 },
      (_, index): WarningRecord => ({
        id: 1000 + index,
        moderatorId: "123456789012345678",
        reason: `${"ż".repeat(300)}\n${"x".repeat(211)}`,
        createdAt: at,
      }),
    );
    const { run } = setup({}, { warnings: records });
    const content = text((await run("warnings", { user: TARGET })).replies) ?? "";
    expect([...content].length).toBeLessThanOrEqual(2000);
    const lines = content.split("\n");
    expect(lines[0]).toBe(`<@${TARGET}> ma 25 ostrzeżeń, 10 najnowszych:`);
    expect(lines).toHaveLength(11);
    for (const line of lines.slice(1)) {
      const reason = line.slice(line.indexOf(">: ") + 3);
      expect([...reason]).toHaveLength(120);
      expect(reason.endsWith("…")).toBe(true);
    }
  });

  test("when lines must be dropped, the header counts only the lines shown", async () => {
    // A moderator id this long cannot come from Discord; it stands in for any line too long to fit ten.
    const records = Array.from(
      { length: 10 },
      (_, index): WarningRecord => ({
        id: index,
        moderatorId: "9".repeat(150),
        reason: "r".repeat(120),
        createdAt: at,
      }),
    );
    const { run } = setup({}, { warnings: records });
    const content = text((await run("warnings", { user: TARGET })).replies) ?? "";
    expect([...content].length).toBeLessThanOrEqual(2000);
    const lines = content.split("\n");
    const shown = lines.length - 1;
    expect(shown).toBeLessThan(10);
    expect(lines[0]).toBe(`<@${TARGET}> ma 10 ostrzeżeń, ${shown} najnowszych:`);
  });

  test("warnings of someone who already left are still shown", async () => {
    const records: WarningRecord[] = [{ id: 1, moderatorId: CALLER, reason: "a", createdAt: at }];
    const { run } = setup({}, { warnings: records });
    const ctx = await run("warnings", { user: STRANGER });
    expect(text(ctx.replies)).toStartWith(`<@${STRANGER}> ma 1 ostrzeżenie:`);
  });

  test("the prefix form sends the list by DM and only says so on the channel", async () => {
    const records: WarningRecord[] = [{ id: 1, moderatorId: CALLER, reason: "a", createdAt: at }];
    const { run, calls } = setup({}, { warnings: records });
    const ctx = await run("warnings", { user: TARGET }, { invocation: "prefix" });
    expect(text(ctx.replies)).toBe(WARNINGS_SENT);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "dm", userId: CALLER });
    expect(calls[0]?.kind === "dm" && calls[0].text).toStartWith(`<@${TARGET}> ma 1 ostrzeżenie:`);
  });

  test("the prefix form points to /warnings when the DM fails or is refused", async () => {
    for (const options of [{ dmFails: true }, { dmClosed: true }]) {
      const { run } = setup(options);
      const ctx = await run("warnings", { user: TARGET }, { invocation: "prefix" });
      expect(text(ctx.replies)).toBe(WARNINGS_DM_CLOSED);
    }
  });
});

describe("purge", () => {
  test("slash deletes the newest messages, answers privately and records the count", async () => {
    const { run, calls, entries } = setup({ purgeResult: { deleted: 5 } });
    const ctx = await run("purge", { count: 5 });
    expect(calls).toEqual([{ kind: "purge", channelId: CHANNEL, count: 5, skipNewest: 0 }]);
    expect(ctx.deferOptions).toEqual({ ephemeral: true });
    expect(text(ctx.replies)).toBe("Usunięto 5 wiadomości.");
    expect(entries).toEqual([
      {
        guildId: GUILD,
        action: "purge",
        moderatorId: CALLER,
        targetId: null,
        channelId: CHANNEL,
        reason: null,
        durationMs: null,
        messageCount: 5,
      },
    ]);
  });

  test("prefix skips its own message so the reply has something to answer", async () => {
    const { run, calls } = setup();
    await run("purge", { count: 10 }, { invocation: "prefix" });
    expect(calls).toEqual([{ kind: "purge", channelId: CHANNEL, count: 10, skipNewest: 1 }]);
  });

  test("old and pinned messages are reported with the right plural", async () => {
    const expected: [number, string][] = [
      [1, "Usunięto 1 wiadomość. Pominięto 1 starszą niż 14 dni. Pominięto 1 przypiętą."],
      [2, "Usunięto 2 wiadomości. Pominięto 2 starsze niż 14 dni. Pominięto 2 przypięte."],
      [5, "Usunięto 5 wiadomości. Pominięto 5 starszych niż 14 dni. Pominięto 5 przypiętych."],
      [12, "Usunięto 12 wiadomości. Pominięto 12 starszych niż 14 dni. Pominięto 12 przypiętych."],
      [22, "Usunięto 22 wiadomości. Pominięto 22 starsze niż 14 dni. Pominięto 22 przypięte."],
    ];
    for (const [n, reply] of expected) {
      const { run } = setup({ purgeResult: { deleted: n, tooOld: n, pinned: n } });
      expect(text((await run("purge", { count: 100 })).replies)).toBe(reply);
    }
  });

  test("nothing deleted means nothing recorded", async () => {
    const { run, entries } = setup({ purgeResult: { deleted: 0, tooOld: 4 } });
    const ctx = await run("purge", { count: 4 });
    expect(text(ctx.replies)).toBe("Usunięto 0 wiadomości. Pominięto 4 starsze niż 14 dni.");
    expect(entries).toEqual([]);
  });

  test("a failed record is noted in the reply", async () => {
    const { run } = setup({}, { fails: true });
    const ctx = await run("purge", { count: 3 });
    expect(text(ctx.replies)).toBe(`Usunięto 3 wiadomości.${NOT_RECORDED}`);
  });

  test("counts outside 1–100 are refused without deleting", async () => {
    for (const count of [0, 101, -3, 2.5]) {
      const { run, calls } = setup();
      const ctx = await run("purge", { count });
      expect(text(ctx.replies)).toBe("Podaj liczbę od 1 do 100.");
      expect(calls).toEqual([]);
    }
  });

  test("100 is the most that can be purged at once", async () => {
    const { run, calls } = setup();
    await run("purge", { count: 100 });
    expect(calls[0]).toMatchObject({ count: 100 });
  });
});
