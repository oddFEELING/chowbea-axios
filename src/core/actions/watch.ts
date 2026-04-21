/**
 * Watch action - continuously polls for OpenAPI spec changes and regenerates.
 * Pure business logic extracted from the Watch command.
 * No oclif dependencies, no process.exit, no this.parse.
 *
 * Uses AbortSignal for cancellation support, making it safe for TUI integration.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import { formatDuration } from "../../adapters/logger-interface.js";
import {
	ensureOutputFolders,
	getOutputPaths,
	loadConfig,
} from "../config.js";
import { fetchOpenApiSpec, saveSpec } from "../fetcher.js";
import { generate, generateClientFiles } from "../generator.js";

/**
 * Options for the watch action.
 */
export interface WatchActionOptions {
	/** Path to api.config.toml */
	configPath?: string;
	/** Polling interval in milliseconds (overrides config) */
	intervalMs?: number;
	/** Enable debug logging (overrides config) */
	debug?: boolean;
	/** AbortSignal for cancellation support (e.g., from TUI) */
	signal?: AbortSignal;
}

/**
 * Callbacks for watch lifecycle events.
 * The TUI can hook into these to update its display.
 */
export interface WatchCallbacks {
	/** Called when a new polling cycle starts */
	onCycleStart?(cycleId: number): void;
	/** Called when a cycle completes successfully */
	onCycleComplete?(cycleId: number, changed: boolean, durationMs: number): void;
	/** Called when a cycle fails with an error */
	onCycleError?(cycleId: number, error: Error): void;
	/** Called when watch mode is shutting down */
	onShutdown?(): void;
}

/**
 * Delays execution for the specified milliseconds.
 * Respects AbortSignal for early termination.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}

		let onAbort: (() => void) | undefined;

		const timer = setTimeout(() => {
			if (onAbort && signal) {
				signal.removeEventListener("abort", onAbort);
			}
			resolve();
		}, ms);

		// Listen for abort to resolve early and clean up the timer
		if (signal) {
			onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * Executes the watch action: continuously poll for spec changes and regenerate.
 *
 * The watch loop runs until the AbortSignal is triggered or the process is interrupted.
 * Returns a promise that resolves when the watch loop exits.
 *
 * @param options - Watch action options (replaces CLI flags)
 * @param logger - Logger instance for output
 * @param callbacks - Optional lifecycle callbacks for TUI integration
 */
export async function executeWatch(
	options: WatchActionOptions,
	logger: Logger,
	callbacks?: WatchCallbacks,
): Promise<void> {
	// Load configuration first (auto-creates if missing)
	const { config, projectRoot, configPath, wasCreated } = await loadConfig(
		options.configPath,
	);

	logger.header("chowbea-axios watch");
	logger.debug("Configuration loaded successfully");

	if (wasCreated) {
		logger.warn(
			{ configPath },
			"Created default api.config.toml - please review and update settings",
		);
	}

	// Get output paths
	const outputPaths = getOutputPaths(config, projectRoot);
	logger.debug({ outputPaths }, "Resolved output paths");

	// Ensure output folders exist (_internal, _generated)
	await ensureOutputFolders(outputPaths);

	// Generate client files if they don't exist (once at startup)
	await generateClientFiles({
		paths: outputPaths,
		instanceConfig: config.instance,
		logger,
	});

	// Determine polling interval
	const intervalMs = options.intervalMs ?? config.poll_interval_ms;
	const endpoint = config.api_endpoint;

	// Announce the watch loop at info level so the user knows what's being
	// polled and at what cadence. In debug mode the full context also fires.
	logger.step(
		"watch",
		`Polling every ${formatDuration(intervalMs)} — ${endpoint}`,
	);
	logger.debug({ endpoint, intervalMs }, "config");

	let cycleCounter = 0;
	const signal = options.signal;

	// Main watch loop
	while (!signal?.aborted) {
		cycleCounter++;
		const cycleId = cycleCounter;

		await runCycle({
			cycleId,
			endpoint,
			outputPaths,
			logger,
			headers: config.fetch?.headers,
			callbacks,
		});

		// Wait before next cycle (respects abort signal)
		if (!signal?.aborted) {
			await abortableDelay(intervalMs, signal);
		}
	}

	// Shutdown
	logger.warn("Shutting down watch mode...");
	logger.info("Cache preserved for next run");
	callbacks?.onShutdown?.();
}

/**
 * Runs a single watch cycle - fetch, check for changes, regenerate if needed.
 */
async function runCycle(options: {
	cycleId: number;
	endpoint: string;
	outputPaths: ReturnType<typeof getOutputPaths>;
	logger: Logger;
	headers?: Record<string, string>;
	callbacks?: WatchCallbacks;
}): Promise<void> {
	const { cycleId, endpoint, outputPaths, logger, headers, callbacks } = options;
	const startTime = Date.now();

	// Notify cycle start
	callbacks?.onCycleStart?.(cycleId);

	// Only show cycle separator in debug mode
	if (logger.level === "debug") {
		logger.step("cycle", `Cycle ${cycleId}`);
	}

	try {
		// Fetch the spec with retry logic (debug level - only shown with --debug)
		logger.debug({ cycleId, endpoint }, "Checking for API changes...");

		const fetchResult = await fetchOpenApiSpec({
			endpoint,
			specPath: outputPaths.spec,
			cachePath: outputPaths.cache,
			logger,
			force: false,
			headers,
		});

		// Handle network fallback
		if (fetchResult.fromCache) {
			logger.warn({ cycleId }, "Using cached spec due to network issues");
		}

		// Heartbeat: one line per cycle so watch mode isn't silent when
		// nothing changes. Compact format so it's tolerable at any interval.
		if (!fetchResult.hasChanged) {
			const durationMs = Date.now() - startTime;
			logger.info(
				{ cycle: cycleId, duration: formatDuration(durationMs) },
				"no changes",
			);
			callbacks?.onCycleComplete?.(cycleId, false, durationMs);
			return;
		}

		// Save the new spec
		await saveSpec({
			buffer: fetchResult.buffer,
			hash: fetchResult.hash,
			endpoint,
			specPath: outputPaths.spec,
			cachePath: outputPaths.cache,
		});

		logger.info(
			{ cycleId, bytes: fetchResult.buffer.length },
			"New spec detected, regenerating...",
		);

		// Run generation
		const result = await generate({
			paths: outputPaths,
			logger,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			{
				cycleId,
				operations: result.operationCount,
				duration: formatDuration(result.durationMs),
			},
			"Generation completed",
		);

		callbacks?.onCycleComplete?.(cycleId, true, durationMs);
	} catch (error) {
		const cycleError = error instanceof Error ? error : new Error(String(error));

		// Log error but continue watching
		logger.error(
			{
				cycleId,
				error: cycleError.message,
			},
			"Cycle failed, will retry next interval",
		);

		callbacks?.onCycleError?.(cycleId, cycleError);
	}
}
