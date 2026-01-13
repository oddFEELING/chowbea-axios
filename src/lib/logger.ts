/**
 * Simple CLI logger with ora spinners and vertical flow connectors.
 * Clean, minimal output appropriate for command-line tools.
 */

import path from "node:path";
import ora, { type Ora } from "ora";

/**
 * Log level for filtering output.
 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/**
 * Options for creating a logger instance.
 */
export interface LoggerOptions {
  /** Log level (default: "info") */
  level?: LogLevel;
}

/**
 * Log level priority (higher = more verbose).
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Vertical line connector for log flow */
const PIPE = "│";

/**
 * Simple logger with ora spinner support.
 * Provides clean CLI output with vertical flow connectors.
 */
export interface Logger {
  /** Current log level */
  level: LogLevel;

  /** Log info message - shows with ✓ icon */
  info(message: string): void;
  info(context: Record<string, unknown>, message: string): void;

  /** Log warning - shows with ⚠ icon */
  warn(message: string): void;
  warn(context: Record<string, unknown>, message: string): void;

  /** Log error - shows with ✗ icon */
  error(message: string): void;
  error(context: Record<string, unknown>, message: string): void;

  /** Log debug - only shown in verbose mode */
  debug(message: string): void;
  debug(context: Record<string, unknown>, message: string): void;

  /** Start a spinner for async operations */
  spin(message: string): Ora;
}

/**
 * Shortens an absolute path to be relative to cwd.
 */
function shortenPath(value: string): string {
  const cwd = process.cwd();
  if (value.startsWith(cwd)) {
    return path.relative(cwd, value) || ".";
  }
  return value;
}

/**
 * Formats a context value, shortening paths automatically.
 */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    // Check if it looks like an absolute path
    if (value.startsWith("/") && value.includes("/")) {
      return shortenPath(value);
    }
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Formats context object into a readable string.
 * Shows key=value pairs inline, with paths shortened.
 */
function formatContext(context: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Creates a logger instance with the specified options.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const levelPriority = LOG_LEVELS[level];

  // Check if a given level should be logged
  const shouldLog = (msgLevel: LogLevel): boolean =>
    LOG_LEVELS[msgLevel] <= levelPriority;

  // Active spinner reference (only one at a time)
  let activeSpinner: Ora | null = null;

  // Stop any active spinner before logging
  const clearSpinner = () => {
    if (activeSpinner && activeSpinner.isSpinning) {
      activeSpinner.stop();
      activeSpinner = null;
    }
  };

  return {
    level,

    info(contextOrMessage: string | Record<string, unknown>, message?: string) {
      if (!shouldLog("info")) return;
      clearSpinner();

      console.log(PIPE);
      if (typeof contextOrMessage === "string") {
        console.log(`${PIPE} ✓ ${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.log(`${PIPE} ✓ ${message}${ctx}`);
      }
    },

    warn(contextOrMessage: string | Record<string, unknown>, message?: string) {
      if (!shouldLog("warn")) return;
      clearSpinner();

      console.log(PIPE);
      if (typeof contextOrMessage === "string") {
        console.log(`${PIPE} ⚠ ${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.log(`${PIPE} ⚠ ${message}${ctx}`);
      }
    },

    error(
      contextOrMessage: string | Record<string, unknown>,
      message?: string
    ) {
      if (!shouldLog("error")) return;
      clearSpinner();

      console.log(PIPE);
      if (typeof contextOrMessage === "string") {
        console.error(`${PIPE} ✗ ${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.error(`${PIPE} ✗ ${message}${ctx}`);
      }
    },

    debug(
      contextOrMessage: string | Record<string, unknown>,
      message?: string
    ) {
      if (!shouldLog("debug")) return;
      clearSpinner();

      console.log(PIPE);
      if (typeof contextOrMessage === "string") {
        console.log(`${PIPE}   ${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.log(`${PIPE}   ${message}${ctx}`);
      }
    },

    spin(message: string): Ora {
      clearSpinner();

      if (!shouldLog("info")) {
        // Return a no-op spinner for silent mode
        return ora({ isSilent: true });
      }

      console.log(PIPE);
      activeSpinner = ora({
        text: message,
        prefixText: PIPE,
      }).start();
      return activeSpinner;
    },
  };
}

/**
 * Determines log level from CLI flags and config.
 * Priority: quiet > debug flag > config debug > default (warn)
 */
export function getLogLevel(
  flags: {
    quiet?: boolean;
    debug?: boolean;
  },
  configDebug?: boolean
): LogLevel {
  if (flags.quiet) return "error";
  if (flags.debug || configDebug) return "debug";
  return "warn";
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Logs a section separator for visual clarity.
 */
export function logSeparator(_logger: Logger, title?: string): void {
  if (title) {
    console.log();
    console.log(`╭${"─".repeat(40)}`);
    console.log(`│ ${title}`);
    console.log(`├${"─".repeat(40)}`);
  } else {
    console.log(PIPE);
    console.log(`╰${"─".repeat(40)}`);
  }
}

/**
 * Default shared logger instance.
 */
export const defaultLogger = createLogger();
