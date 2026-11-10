import { describe, expect, test } from "bun:test";
import type { LogFields, Logger } from "@dzajcarz/core";
import { silentLogger } from "@dzajcarz/core";
import { createGuildCleanup } from "./guild-cleanup.ts";

function recordingLogger() {
  const lines: { level: string; message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => void lines.push({ level: "info", message, fields }),
    error: (message, fields) => void lines.push({ level: "error", message, fields }),
    child: () => logger,
  };
  return { lines, logger };
}

describe("guild cleanup", () => {
  test("forgets the server and logs what went", async () => {
    const steps: string[] = [];
    const { lines, logger } = recordingLogger();
    const cleanup = createGuildCleanup(
      {
        forget: async (guildId) => {
          steps.push(`forget ${guildId}`);
          return { welcome_config: 1 };
        },
      },
      [async (guildId) => void steps.push(`prefix ${guildId}`)],
      logger,
    );
    await cleanup({ id: "100000000000000001" });
    // The caches reload only after the rows are gone, so they cannot pick the old settings back up.
    expect(steps).toEqual(["forget 100000000000000001", "prefix 100000000000000001"]);
    expect(lines).toEqual([
      {
        level: "info",
        message: "Removed the data of a server the bot left",
        fields: { guildId: "100000000000000001", removed: { welcome_config: 1 } },
      },
    ]);
  });

  test("a database failure is logged, not thrown into the client", async () => {
    const { lines, logger } = recordingLogger();
    const cleanup = createGuildCleanup(
      { forget: () => Promise.reject(new Error("postgres down")) },
      [],
      logger,
    );
    await expect(cleanup({ id: "1" })).resolves.toBeUndefined();
    expect(lines.map((line) => line.level)).toEqual(["error"]);
  });
});
