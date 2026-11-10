import { expect, test } from "bun:test";
import { createJsonLogger } from "./logger.ts";

test("writes JSON lines at or above the level, with child fields", () => {
  const lines: string[] = [];
  const logger = createJsonLogger({
    level: "info",
    write: (line) => lines.push(line),
    now: () => new Date("2026-11-06T12:00:00Z"),
  });
  logger.debug("hidden");
  logger.child({ module: "music" }).warn("Node down", { node: "main", guild: 1n });

  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      time: "2026-11-06T12:00:00.000Z",
      level: "warn",
      msg: "Node down",
      module: "music",
      node: "main",
      guild: "1",
    },
  ]);
});

function lastLine(log: (logger: ReturnType<typeof createJsonLogger>) => void) {
  const lines: string[] = [];
  log(createJsonLogger({ level: "info", write: (line) => lines.push(line) }));
  return JSON.parse(lines.at(-1) ?? "{}");
}

test("a Discord API error keeps its code, status and method, but not its URL or body", () => {
  const error = Object.assign(new Error("Missing Permissions"), {
    name: "DiscordAPIError[50013]",
    code: 50013,
    status: 403,
    method: "POST",
    url: "https://discord.com/api/v10/interactions/1/secret-token/callback",
    requestBody: { json: { content: "what a member typed" } },
  });
  const { error: logged } = lastLine((logger) => logger.error("Reply failed", { error }));
  expect(logged).toMatchObject({
    name: "DiscordAPIError[50013]",
    message: "Missing Permissions",
    code: 50013,
    status: 403,
    method: "POST",
  });
  expect(logged.url).toBeUndefined();
  expect(logged.requestBody).toBeUndefined();
});

test("a system error keeps its string code, and a cause is described one level deep", () => {
  const root = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const middle = new Error("Redis down", { cause: root });
  const error = new Error("Prefix lookup failed", { cause: middle });
  const { error: logged } = lastLine((logger) => logger.warn("x", { error }));
  expect(logged.cause).toMatchObject({ message: "Redis down" });
  expect(logged.cause.cause).toBeUndefined();
  const direct = lastLine((logger) => logger.warn("x", { error: root })).error;
  expect(direct.code).toBe("ECONNREFUSED");
});

test("a Postgres error keeps its SQLSTATE, and a plain string cause is kept as it is", () => {
  const error = Object.assign(new Error("duplicate key"), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "23505",
    cause: "unique_violation",
  });
  expect(lastLine((logger) => logger.warn("x", { error })).error).toMatchObject({
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "23505",
    cause: "unique_violation",
  });
});

test("non-primitive values under the allowed names are left out", () => {
  const error = Object.assign(new Error("odd"), { code: { nested: "secret" } });
  expect(lastLine((logger) => logger.warn("x", { error })).error.code).toBeUndefined();
});

test("a field that cannot be serialized still produces a line instead of throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const lines: string[] = [];
  const logger = createJsonLogger({
    write: (line) => lines.push(line),
    now: () => new Date("2026-11-06T12:00:00Z"),
  });
  expect(() => logger.error("boom", { cyclic })).not.toThrow();
  const line = JSON.parse(lines[0] ?? "");
  expect(line).toMatchObject({ time: "2026-11-06T12:00:00.000Z", level: "error", msg: "boom" });
  expect(typeof line.logError).toBe("string");
});

test("a write that throws does not make the logger throw", () => {
  const logger = createJsonLogger({
    write: () => {
      throw new Error("EPIPE");
    },
  });
  expect(() => logger.error("boom")).not.toThrow();
});

test("the fallback line keeps the child fields", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const lines: string[] = [];
  const logger = createJsonLogger({ write: (line) => lines.push(line) }).child({ module: "music" });
  logger.warn("boom", { cyclic });
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({ module: "music", msg: "boom" });
});
