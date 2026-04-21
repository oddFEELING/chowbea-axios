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
	resolveSpecSource,
	type SpecSource,
} from "../config.js";
import {
	computeHash,
	fetchOpenApiSpec,
	loadCacheMetadata,
	loadLocalSpec,
	saveSpec,
} from "../fetcher.js";
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

	// Determine polling interval and spec source (local file or remote endpoint)
	const intervalMs = options.intervalMs ?? config.poll_interval_ms;
	const specSource = resolveSpecSource(config, projectRoot);

	logger.step("watch", "Starting watch mode...");
	logger.debug({ specSource, intervalMs }, "config");

	let cycleCounter = 0;
	const signal = options.signal;

	// Main watch loop
	while (!signal?.aborted) {
		cycleCounter++;
		const cycleId = cycleCounter;

		await runCycle({
			cycleId,
			specSource,
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
 * Runs a single watch cycle - load (fetch or read) the spec, check for changes,
 * regenerate if needed.
 */
async function runCycle(options: {
	cycleId: number;
	specSource: SpecSource;
	outputPaths: ReturnType<typeof getOutputPaths>;
	logger: Logger;
	headers?: Record<string, string>;
	callbacks?: WatchCallbacks;
}): Promise<void> {
	const { cycleId, specSource, outputPaths, logger, headers, callbacks } =
		options;
	const startTime = Date.now();

	// Notify cycle start
	callbacks?.onCycleStart?.(cycleId);

	// Only show cycle separator in debug mode
	if (logger.level === "debug") {
		logger.step("cycle", `Cycle ${cycleId}`);
	}

	try {
		let newBuffer: Buffer;
		let newHash: string;
		let sourceIdentifier: string;
		let hasChanged: boolean;

		if (specSource.type === "local") {
			// Local file mode — hash file contents and compare against cache
			sourceIdentifier = specSource.path;
			logger.debug({ cycleId, path: specSource.path }, "Checking local spec...");
			const { buffer } = await loadLocalSpec(specSource.path);
			newBuffer = buffer;
			newHash = computeHash(buffer);

			// Compare against previously-saved spec hash
			const existingCache = await loadCacheMetadata(outputPaths.cache);
			hasChanged = existingCache?.hash !== newHash;
		} else {
			// Remote mode — fetch with retry
			sourceIdentifier = specSource.endpoint;
			logger.debug(
				{ cycleId, endpoint: specSource.endpoint },
				"Checking for API changes...",
			);
			const fetchResult = await fetchOpenApiSpec({
				endpoint: specSource.endpoint,
				specPath: outputPaths.spec,
				cachePath: outputPaths.cache,
				logger,
				force: false,
				headers,
			});

			if (fetchResult.fromCache) {
				logger.warn({ cycleId }, "Using cached spec due to network issues");
			}

			newBuffer = fetchResult.buffer;
			newHash = fetchResult.hash;
			hasChanged = fetchResult.hasChanged;
		}

		// Skip if unchanged (debug level - only shown with --debug)
		if (!hasChanged) {
			const durationMs = Date.now() - startTime;
			logger.debug(
				{ cycleId, durationMs: formatDuration(durationMs) },
				"No changes detected, skipping generation",
			);
			callbacks?.onCycleComplete?.(cycleId, false, durationMs);
			return;
		}

		// Save the new spec
		await saveSpec({
			buffer: newBuffer,
			hash: newHash,
			endpoint: sourceIdentifier,
			specPath: outputPaths.spec,
			cachePath: outputPaths.cache,
		});

		logger.info(
			{ cycleId, bytes: newBuffer.length },
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
