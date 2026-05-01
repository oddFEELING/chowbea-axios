/**
 * CLI logger with colored, grouped output.
 * Turborepo-style sections with colored prefixes.
 * Implements the Logger interface from adapters/logger-interface.ts.
 */

import path from "node:path";
import pc from "picocolors";

import type {
	Logger,
	LoggerOptions,
	LogLevel,
} from "../adapters/logger-interface.js";
import { LOG_LEVELS } from "../adapters/logger-interface.js";

// Re-export for backwards compatibility
export type { Logger, LoggerOptions, LogLevel };
export { LOG_LEVELS, getLogLevel, formatDuration } from "../adapters/logger-interface.js";

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
 *
 * Path-shortening triggers on any absolute path or `./`/`../`-relative
 * path. Uses `path.isAbsolute` so Windows paths (`C:\…`) are recognized
 * — the previous `value.startsWith("/")` test only matched POSIX-style
 * paths and silently bypassed shortening on Windows. Issue #44.
 */
function formatValue(value: unknown): string {
	if (typeof value === "string") {
		const isPathLike =
			path.isAbsolute(value) ||
			value.startsWith("./") ||
			value.startsWith("../");
		if (isPathLike) {
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

	return {
		level,

		header(title: string) {
			console.log();
			console.log(`  ${pc.bold(title)}`);
			console.log();
		},

		step(label: string, message: string) {
			if (!shouldLog("info")) return;
			console.log(`  ${pc.cyan("●")} ${pc.bold(pc.cyan(padLabel(label)))}${message}`);
		},

		info(contextOrMessage: string | Record<string, unknown>, message?: string) {
			if (!shouldLog("info")) return;

			if (typeof contextOrMessage === "string") {
				console.log(`${INDENT}${pc.green("✓")} ${contextOrMessage}`);
			} else {
				const ctx = formatContext(contextOrMessage);
				console.log(`${INDENT}${pc.green("✓")} ${message}${ctx ? `  ${ctx}` : ""}`);
			}
		},

		warn(contextOrMessage: string | Record<string, unknown>, message?: string) {
			if (!shouldLog("warn")) return;

			if (typeof contextOrMessage === "string") {
				console.log(`  ${pc.yellow("⚠")} ${pc.yellow(padLabel("warn"))}${contextOrMessage}`);
			} else {
				const ctx = formatContext(contextOrMessage);
				console.log(`  ${pc.yellow("⚠")} ${pc.yellow(padLabel("warn"))}${message}${ctx ? `  ${ctx}` : ""}`);
			}
		},

		error(contextOrMessage: string | Record<string, unknown>, message?: string) {
			if (!shouldLog("error")) return;

			if (typeof contextOrMessage === "string") {
				console.error(`  ${pc.red("✗")} ${pc.red(padLabel("error"))}${contextOrMessage}`);
			} else {
				const ctx = formatContext(contextOrMessage);
				console.error(`  ${pc.red("✗")} ${pc.red(padLabel("error"))}${message}${ctx ? `  ${ctx}` : ""}`);
			}
		},

		debug(contextOrMessage: string | Record<string, unknown>, message?: string) {
			if (!shouldLog("debug")) return;

			if (typeof contextOrMessage === "string") {
				console.log(`${INDENT}${pc.dim(contextOrMessage)}`);
			} else {
				const ctx = formatContext(contextOrMessage);
				console.log(`${INDENT}${pc.dim(message)}${ctx ? `  ${ctx}` : ""}`);
			}
		},

		done(message: string) {
			if (!shouldLog("info")) return;
			console.log();
			console.log(`  ${pc.green("✓")} ${pc.bold(pc.green(padLabel("done")))}${message}`);
			console.log();
		},

		startProgress(message: string) {
			if (!shouldLog("info")) return;
			// Simple text-based progress for headless mode
			console.log(`${INDENT}${pc.cyan("\u23F3")} ${message}`);
		},

		stopProgress() {
			// No-op for text-based progress
		},
	};
}

/**
 * Default shared logger instance.
 */
export const defaultLogger = createLogger();
