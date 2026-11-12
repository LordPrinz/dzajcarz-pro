import type { ProtocolLogger } from "./logger.ts";
import type { CommandHandlers } from "./server.ts";

/** A logger that remembers what it was told, for tests. */
export function recordingLogger(): ProtocolLogger & { lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, debug: record("debug"), warn: record("warn"), error: record("error") };
}

const notInThisTest = (name: string) => async () => {
  throw new Error(`${name} is not handled in this test`);
};

/** Every command handler, failing unless the test passes its own, so a test names only what it uses. */
export function commandHandlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    "guilds.list": notInThisTest("guilds.list"),
    "guilds.channels": notInThisTest("guilds.channels"),
    "archive.guild.set": notInThisTest("archive.guild.set"),
    "archive.dm.set": notInThisTest("archive.dm.set"),
    "archive.backfill": notInThisTest("archive.backfill"),
    ...overrides,
  };
}
