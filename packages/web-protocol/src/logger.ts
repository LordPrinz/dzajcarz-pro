/** The slice of a logger this package uses; `Logger` from `@dzajcarz/core` fits. */
export interface ProtocolLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
