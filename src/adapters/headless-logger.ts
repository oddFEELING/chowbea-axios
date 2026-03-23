/**
 * Headless logger adapter -- re-exports the core logger for CLI use.
 */
export { createLogger, defaultLogger } from "../core/logger.js";
export type { Logger, LoggerOptions, LogLevel } from "../adapters/logger-interface.js";
export { getLogLevel, formatDuration } from "../adapters/logger-interface.js";
