/**
 * Logger interface — the contract between core business logic and UI.
 * Implementations: headless-logger (picocolors stdout) and tui-logger (React state).
 */

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
 * Logger with grouped section output.
 * Core libraries depend on this interface only — not on any specific renderer.
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

	/** Start a progress indicator for async operations */
	startProgress(message: string): void;

	/** Stop the current progress indicator */
	stopProgress(): void;
}

/**
 * Log level priority (higher = more verbose).
 */
export const LOG_LEVELS: Record<LogLevel, number> = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

/**
 * Determines log level from CLI flags and config.
 * Priority: quiet > verbose/debug flag > config debug > default (info).
 *
 * Default is `info` — users running the CLI without flags should see progress
 * updates and success messages, not total silence. `warn` is only reached via
 * the explicit `--quiet`-adjacent path and via `silent`/error handling.
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
	return "info";
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
