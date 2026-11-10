export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line, e.g. `{ module: "music" }`. */
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

/** One JSON object per line on stdout, ready for `docker logs` or any log shipper. */
export function createJsonLogger(
  {
    level = "info",
    write = (line) => process.stdout.write(`${line}\n`),
    now = () => new Date(),
  }: JsonLoggerOptions = {},
  base: LogFields = {},
): Logger {
  const min = LEVELS[level];
  const log =
    (lvl: LogLevel) =>
    (message: string, fields: LogFields = {}) => {
      if (LEVELS[lvl] < min) return;
      // A logger never throws: a cyclic object in `fields` or a closed stdout must not crash the caller.
      try {
        const time = now().toISOString();
        const line = { time, level: lvl, msg: message };
        try {
          write(JSON.stringify({ ...line, ...base, ...fields }, errorReplacer));
        } catch (error) {
          const logError = String(error);
          try {
            write(JSON.stringify({ ...line, ...base, logError }, errorReplacer));
          } catch {
            write(JSON.stringify({ ...line, logError }));
          }
        }
      } catch {}
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createJsonLogger({ level, write, now }, { ...base, ...fields }),
  };
}

/**
 * Extra error properties worth logging: Discord's error `code` (50013 is Missing Permissions), the HTTP
 * `status` and `method`, and `errno`, where Bun.SQL keeps the Postgres SQLSTATE (23505 is a duplicate key). Anything else stays out on purpose: `url` of an interaction holds its token, and a
 * request body can hold what members typed.
 */
const LOGGED_ERROR_FIELDS = ["code", "errno", "status", "method"] as const;

/** An error as plain data; its `cause` is described too, one level deep. */
function describeError(error: Error, depth = 0): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const field of LOGGED_ERROR_FIELDS) {
    const value: unknown = (error as unknown as Record<string, unknown>)[field];
    if (typeof value === "string" || typeof value === "number") described[field] = value;
  }
  if (depth === 0 && error.cause instanceof Error) {
    described.cause = describeError(error.cause, depth + 1);
  } else if (depth === 0 && typeof error.cause === "string") {
    described.cause = error.cause;
  }
  return described;
}

/** Errors stringify to `{}` by default, which hides exactly what a log is for. */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Discards everything; for tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
