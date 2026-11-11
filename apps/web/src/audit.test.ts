import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type {
  FinalWebAuditOutcome,
  NewWebAuditEntry,
  WebAuditOutcome,
  WebAuditRepository,
} from "@dzajcarz/db";
import type { BotResult } from "@dzajcarz/web-protocol";
import { actorOf, createAuditor } from "./audit.ts";

const request = (headers: Record<string, string> = {}) =>
  new Request("https://panel.example.com/api/x", { method: "POST", headers });

type Row = NewWebAuditEntry & { outcome: WebAuditOutcome; error: string | null };

function setup({ failStart = false, failFinish = false } = {}) {
  const rows: Row[] = [];
  const errors: string[] = [];
  const repository: WebAuditRepository = {
    async start(entry) {
      if (failStart) throw new Error("db down");
      rows.push({ ...entry, outcome: "pending", error: null });
      return { id: rows.length };
    },
    async finish(id: number, outcome: FinalWebAuditOutcome, error: string | null = null) {
      if (failFinish) throw new Error("db down");
      const row = rows[id - 1];
      if (row) Object.assign(row, { outcome, error });
    },
  };
  const auditor = createAuditor({
    repository,
    logger: { ...silentLogger, error: (message) => void errors.push(message) },
  });
  return { auditor, rows, errors };
}

const okAction = async () => ({ ok: true as const, data: 1 });

describe("actorOf", () => {
  test("reads and trims X-authentik-username", () => {
    expect(actorOf(request({ "X-authentik-username": "  owner  " }))).toBe("owner");
  });

  test("is null without the header or with a blank one", () => {
    expect(actorOf(request())).toBeNull();
    expect(actorOf(request({ "X-authentik-username": "   " }))).toBeNull();
  });

  test("is cut to 255 characters", () => {
    expect(actorOf(request({ "X-authentik-username": "a".repeat(300) }))?.length).toBe(255);
  });

  test("drops control characters", () => {
    const headers = new Headers();
    headers.set("X-authentik-username", "own\ter\x7f");
    const withControls = new Request("https://panel.example.com/api/x", { headers });
    expect(actorOf(withControls)).toBe("owner");
  });
});

describe("audited", () => {
  const cases: [string, BotResult<string>, WebAuditOutcome, string | null][] = [
    ["ok", { ok: true, data: "x" }, "ok", null],
    ["unavailable", { ok: false, reason: "unavailable" }, "unavailable", null],
    ["timeout", { ok: false, reason: "timeout" }, "timeout", null],
    ["error", { ok: false, reason: "error", message: "nope" }, "failed", "nope"],
  ];

  test.each(cases)("a %s result is recorded as %s", async (_name, result, outcome, error) => {
    const { auditor, rows } = setup();
    const returned = await auditor.audited(
      request({ "X-authentik-username": "owner" }),
      "message.send",
      { guildId: "1", channelId: "2", payload: { content: "hej" } },
      async () => result,
    );
    expect(returned).toBe(result);
    expect(rows).toEqual([
      {
        actor: "owner",
        action: "message.send",
        guildId: "1",
        channelId: "2",
        payload: { content: "hej" },
        outcome,
        error,
      },
    ]);
  });

  test("the row is pending while the action runs", async () => {
    const { auditor, rows } = setup();
    let seen: WebAuditOutcome | undefined;
    await auditor.audited(request(), "message.send", {}, async () => {
      seen = rows[0]?.outcome;
      return { ok: true as const, data: 1 };
    });
    expect(seen).toBe("pending");
    expect(rows[0]?.outcome).toBe("ok");
  });

  test("when the pending row cannot be written the action never runs", async () => {
    const { auditor, errors } = setup({ failStart: true });
    let ran = false;
    const result = await auditor.audited(request(), "message.send", {}, async () => {
      ran = true;
      return { ok: true as const, data: 1 };
    });
    expect(result).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(ran).toBe(false);
    expect(errors).toEqual(["Could not write the audit log; the action did not run"]);
  });

  test("a failing final write is logged and does not change the result", async () => {
    const { auditor, errors, rows } = setup({ failFinish: true });
    const result = await auditor.audited(request(), "message.send", {}, okAction);
    expect(result).toEqual({ ok: true, data: 1 });
    expect(rows[0]?.outcome).toBe("pending");
    expect(errors).toEqual(["Could not record the outcome in the audit log"]);
  });

  test("the optional context defaults to nulls and an empty payload", async () => {
    const { auditor, rows } = setup();
    await auditor.audited(request(), "message.send", {}, okAction);
    expect(rows[0]).toMatchObject({ guildId: null, channelId: null, payload: {} });
  });

  test("an error message is cut to 1000 characters", async () => {
    const { auditor, rows } = setup();
    await auditor.audited(request(), "message.send", {}, async () => ({
      ok: false as const,
      reason: "error" as const,
      message: "e".repeat(1_500),
    }));
    expect(rows[0]?.error?.length).toBe(1_000);
  });

  test("a throwing action whose final write also fails still rethrows the original error", async () => {
    const { auditor, errors } = setup({ failFinish: true });
    await expect(
      auditor.audited(request(), "message.send", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(errors).toEqual(["Could not record the outcome in the audit log"]);
  });

  test("an action that throws is recorded as failed and the error goes on", async () => {
    const { auditor, rows } = setup();
    await expect(
      auditor.audited(request(), "message.send", {}, async () => {
        throw "boom";
      }),
    ).rejects.toBe("boom");
    expect(rows[0]).toMatchObject({ outcome: "failed", error: "boom", actor: null });
  });
});
