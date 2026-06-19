import type { Logger } from "../../src/adapters/logger-interface.js";

/** A no-op logger for tests that don't assert on output. */
export const SILENT_LOGGER: Logger = {
	level: "silent",
	header: () => {},
	step: () => {},
	info: (() => {}) as Logger["info"],
	warn: (() => {}) as Logger["warn"],
	error: (() => {}) as Logger["error"],
	debug: (() => {}) as Logger["debug"],
	done: () => {},
	startProgress: () => {},
	stopProgress: () => {},
};
