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
      write(
        JSON.stringify(
          { time: now().toISOString(), level: lvl, msg: message, ...base, ...fields },
          errorReplacer,
        ),
      );
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createJsonLogger({ level, write, now }, { ...base, ...fields }),
  };
}

/** Errors stringify to `{}` by default, which hides exactly what a log is for. */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
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
