import type { ProtocolLogger } from "./logger.ts";

/** A logger that remembers what it was told, for tests. */
export function recordingLogger(): ProtocolLogger & { lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, debug: record("debug"), warn: record("warn"), error: record("error") };
}
