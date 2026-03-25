/**
 * TUI Logger — collects log entries in memory instead of writing to stdout.
 * Used by TUI screens to capture action output for display in scrollable views.
 */

import type { Logger, LogLevel } from "../../adapters/logger-interface.js";
import { LOG_LEVELS } from "../../adapters/logger-interface.js";

/**
 * A single log entry captured by the TUI logger.
 */
export interface LogEntry {
	timestamp: number;
	level: "info" | "warn" | "error" | "debug" | "step" | "done";
	message: string;
	context?: Record<string, unknown>;
}

/**
 * Creates a Logger that collects entries in memory for TUI rendering.
 *
 * @param level - Minimum log level to capture (default: "info")
 * @returns Logger instance plus getLogs/clearLogs accessors
 */
export function createTuiLogger(level: LogLevel = "info"): {
	logger: Logger;
	getLogs: () => LogEntry[];
	clearLogs: () => void;
} {
	const MAX_LOG_ENTRIES = 1000;
	const logs: LogEntry[] = [];
	const levelPriority = LOG_LEVELS[level];

	const shouldLog = (msgLevel: LogLevel): boolean =>
		LOG_LEVELS[msgLevel] <= levelPriority;

	const addLog = (entry: LogEntry): void => {
		if (logs.length >= MAX_LOG_ENTRIES) {
			logs.splice(0, logs.length - MAX_LOG_ENTRIES + 1);
		}
		logs.push(entry);
	};

	const logger: Logger = {
		level,

		header(title: string) {
			addLog({ timestamp: Date.now(), level: "info", message: title });
		},

		step(label: string, message: string) {
			if (shouldLog("info")) {
				addLog({
					timestamp: Date.now(),
					level: "step",
					message: `[${label}] ${message}`,
				});
			}
		},

		info(
			contextOrMessage: string | Record<string, unknown>,
			message?: string,
		) {
			if (!shouldLog("info")) return;
			if (typeof contextOrMessage === "string") {
				addLog({
					timestamp: Date.now(),
					level: "info",
					message: contextOrMessage,
				});
			} else {
				addLog({
					timestamp: Date.now(),
					level: "info",
					message: message ?? "",
					context: contextOrMessage,
				});
			}
		},

		warn(
			contextOrMessage: string | Record<string, unknown>,
			message?: string,
		) {
			if (!shouldLog("warn")) return;
			if (typeof contextOrMessage === "string") {
				addLog({
					timestamp: Date.now(),
					level: "warn",
					message: contextOrMessage,
				});
			} else {
				addLog({
					timestamp: Date.now(),
					level: "warn",
					message: message ?? "",
					context: contextOrMessage,
				});
			}
		},

		error(
			contextOrMessage: string | Record<string, unknown>,
			message?: string,
		) {
			if (!shouldLog("error")) return;
			if (typeof contextOrMessage === "string") {
				addLog({
					timestamp: Date.now(),
					level: "error",
					message: contextOrMessage,
				});
			} else {
				addLog({
					timestamp: Date.now(),
					level: "error",
					message: message ?? "",
					context: contextOrMessage,
				});
			}
		},

		debug(
			contextOrMessage: string | Record<string, unknown>,
			message?: string,
		) {
			if (!shouldLog("debug")) return;
			if (typeof contextOrMessage === "string") {
				addLog({
					timestamp: Date.now(),
					level: "debug",
					message: contextOrMessage,
				});
			} else {
				addLog({
					timestamp: Date.now(),
					level: "debug",
					message: message ?? "",
					context: contextOrMessage,
				});
			}
		},

		done(message: string) {
			if (shouldLog("info")) {
				addLog({ timestamp: Date.now(), level: "done", message });
			}
		},

		startProgress(message: string) {
			if (shouldLog("info")) {
				addLog({
					timestamp: Date.now(),
					level: "info",
					message: `... ${message}`,
				});
			}
		},

		stopProgress() {
			/* no-op for TUI — progress is handled by component state */
		},
	};

	return {
		logger,
		getLogs: () => [...logs],
		clearLogs: () => {
			logs.length = 0;
		},
	};
}
