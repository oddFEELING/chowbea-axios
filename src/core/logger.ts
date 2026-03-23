/**
 * CLI logger with colored, grouped output.
 * Turborepo-style sections with colored prefixes.
 */

import path from "node:path";
import pc from "picocolors";
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

/** Indentation for sub-messages under a step */
const INDENT = "              ";
/** Padding for step labels (right-padded) */
const LABEL_WIDTH = 10;

/**
 * Pads a label to a fixed width for alignment.
 */
function padLabel(label: string): string {
  return label.padEnd(LABEL_WIDTH);
}

/**
 * Logger with grouped section output.
 */
export interface Logger {
  /** Current log level */
  level: LogLevel;

  /** Print command header */
  header(title: string): void;

  /** Start a grouped step — ● label  message */
  step(label: string, message: string): void;

  /** Info detail under current step — ✓ message */
  info(message: string): void;
  info(context: Record<string, unknown>, message: string): void;

  /** Warning — ⚠ message in yellow */
  warn(message: string): void;
  warn(context: Record<string, unknown>, message: string): void;

  /** Error — ✗ message in red */
  error(message: string): void;
  error(context: Record<string, unknown>, message: string): void;

  /** Debug detail — dim, only in verbose mode */
  debug(message: string): void;
  debug(context: Record<string, unknown>, message: string): void;

  /** Completion line — ✓ done  message in green */
  done(message: string): void;

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
 * Formats a context value, shortening paths and coloring.
 */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    if (value.startsWith("/") && value.includes("/")) {
      return pc.cyan(shortenPath(value));
    }
    return pc.cyan(value);
  }
  if (typeof value === "number") {
    return pc.yellow(String(value));
  }
  return pc.dim(JSON.stringify(value));
}

/**
 * Formats context object into colored key: value lines.
 */
function formatContext(context: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    parts.push(`${pc.dim(key + ":")} ${formatValue(value)}`);
  }
  return parts.length > 0 ? parts.join(pc.dim(", ")) : "";
}

/**
 * Creates a logger instance with the specified options.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const levelPriority = LOG_LEVELS[level];

  const shouldLog = (msgLevel: LogLevel): boolean =>
    LOG_LEVELS[msgLevel] <= levelPriority;

  let activeSpinner: Ora | null = null;

  const clearSpinner = () => {
    if (activeSpinner && activeSpinner.isSpinning) {
      activeSpinner.stop();
      activeSpinner = null;
    }
  };

  return {
    level,

    header(title: string) {
      clearSpinner();
      console.log();
      console.log(`  ${pc.bold(title)}`);
      console.log();
    },

    step(label: string, message: string) {
      if (!shouldLog("info")) return;
      clearSpinner();
      console.log(`  ${pc.cyan("●")} ${pc.bold(pc.cyan(padLabel(label)))}${message}`);
    },

    info(contextOrMessage: string | Record<string, unknown>, message?: string) {
      if (!shouldLog("info")) return;
      clearSpinner();

      if (typeof contextOrMessage === "string") {
        console.log(`${INDENT}${pc.green("✓")} ${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.log(`${INDENT}${pc.green("✓")} ${message}${ctx ? `  ${ctx}` : ""}`);
      }
    },

    warn(contextOrMessage: string | Record<string, unknown>, message?: string) {
      if (!shouldLog("warn")) return;
      clearSpinner();

      if (typeof contextOrMessage === "string") {
        console.log(`  ${pc.yellow("⚠")} ${pc.yellow(padLabel("warn"))}${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.log(`  ${pc.yellow("⚠")} ${pc.yellow(padLabel("warn"))}${message}${ctx ? `  ${ctx}` : ""}`);
      }
    },

    error(contextOrMessage: string | Record<string, unknown>, message?: string) {
      if (!shouldLog("error")) return;
      clearSpinner();

      if (typeof contextOrMessage === "string") {
        console.error(`  ${pc.red("✗")} ${pc.red(padLabel("error"))}${contextOrMessage}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.error(`  ${pc.red("✗")} ${pc.red(padLabel("error"))}${message}${ctx ? `  ${ctx}` : ""}`);
      }
    },

    debug(contextOrMessage: string | Record<string, unknown>, message?: string) {
      if (!shouldLog("debug")) return;
      clearSpinner();

      if (typeof contextOrMessage === "string") {
        console.log(`${INDENT}${pc.dim(contextOrMessage)}`);
      } else {
        const ctx = formatContext(contextOrMessage);
        console.log(`${INDENT}${pc.dim(message)}${ctx ? `  ${ctx}` : ""}`);
      }
    },

    done(message: string) {
      if (!shouldLog("info")) return;
      clearSpinner();
      console.log();
      console.log(`  ${pc.green("✓")} ${pc.bold(pc.green(padLabel("done")))}${message}`);
      console.log();
    },

    spin(message: string): Ora {
      clearSpinner();

      if (!shouldLog("info")) {
        return ora({ isSilent: true });
      }

      activeSpinner = ora({
        text: message,
        prefixText: INDENT,
        color: "cyan",
      }).start();
      return activeSpinner;
    },
  };
}

/**
 * Determines log level from CLI flags and config.
 * Priority: quiet > verbose/debug flag > config debug > default (warn)
 */
export function getLogLevel(
  flags: {
    quiet?: boolean;
    verbose?: boolean;
    debug?: boolean;
  },
  configDebug?: boolean
): LogLevel {
  if (flags.quiet) return "error";
  if (flags.verbose || flags.debug || configDebug) return "debug";
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
 * Default shared logger instance.
 */
export const defaultLogger = createLogger();
