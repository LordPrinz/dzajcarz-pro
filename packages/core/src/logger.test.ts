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
