/**
 * Minimal structured-logger interface. pino satisfies this shape out of the
 * box, so callers can pass a pino instance without @relay/core taking a pino
 * dependency. Tests can pass `nullLogger` to stay quiet.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child(): Logger {
    return nullLogger;
  },
};
