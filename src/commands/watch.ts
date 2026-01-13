/**
 * Watch command - continuously polls for OpenAPI spec changes and regenerates.
 * Includes graceful shutdown and automatic recovery from transient failures.
 */

import { Command, Flags } from "@oclif/core";

import {
  ensureOutputFolders,
  getOutputPaths,
  loadConfig,
} from "../lib/config.js";
import { formatError } from "../lib/errors.js";
import { fetchOpenApiSpec, saveSpec } from "../lib/fetcher.js";
import { generate, generateClientFiles } from "../lib/generator.js";
import {
  createLogger,
  formatDuration,
  getLogLevel,
  logSeparator,
} from "../lib/logger.js";

/**
 * Watch for OpenAPI spec changes and regenerate automatically.
 */
export default class Watch extends Command {
  static override description = `Continuously poll for spec changes and regenerate.

Useful during development - automatically regenerates types when
your API changes. Press Ctrl+C to stop.

Gracefully handles network failures and preserves cache on shutdown.`;

  static override examples = [
    {
      command: "<%= config.bin %> watch",
      description: "Start watching with default 10s interval",
    },
    {
      command: "<%= config.bin %> watch --interval 5000",
      description: "Poll every 5 seconds",
    },
  ];

  static override flags = {
    config: Flags.string({
      char: "c",
      description: "Path to api.config.toml",
    }),
    interval: Flags.integer({
      char: "i",
      description: "Polling interval in milliseconds",
    }),
    quiet: Flags.boolean({
      char: "q",
      description: "Suppress non-error output",
      default: false,
    }),
    debug: Flags.boolean({
      char: "d",
      description: "Show verbose cycle-by-cycle logs",
      default: false,
    }),
  };

  // Track shutdown state
  private isShuttingDown = false;
  private cycleCounter = 0;

  async run(): Promise<void> {
    const { flags } = await this.parse(Watch);

    // Create initial logger (will be updated after config is loaded)
    let logger = createLogger({ level: "warn" });

    try {
      // Load configuration first (auto-creates if missing)
      const { config, projectRoot, configPath, wasCreated } = await loadConfig(
        flags.config
      );

      // Update logger with appropriate level (uses config.watch.debug if no flag)
      logger = createLogger({
        level: getLogLevel(flags, config.watch.debug),
      });

      logSeparator(logger, "chowbea-axios watch");

      logger.debug("Configuration loaded successfully");

      if (wasCreated) {
        logger.warn(
          { configPath },
          "Created default api.config.toml - please review and update settings"
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
      const intervalMs = flags.interval ?? config.poll_interval_ms;
      const endpoint = config.api_endpoint;

      logger.info(
        { endpoint, intervalMs },
        "Starting watch mode - press Ctrl+C to stop"
      );

      // Set up graceful shutdown handlers
      const shutdown = (signal: string) => {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.warn({ signal }, "Shutting down watch mode...");
        logger.info("Cache preserved for next run");

        // Give time for any current operation to complete
        setTimeout(() => {
          process.exit(0);
        }, 100);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      // Main watch loop
      while (!this.isShuttingDown) {
        this.cycleCounter++;
        const cycleId = this.cycleCounter;

        await this.runCycle({
          cycleId,
          endpoint,
          outputPaths,
          logger,
          headers: config.fetch?.headers,
        });

        // Wait before next cycle
        if (!this.isShuttingDown) {
          await this.delay(intervalMs);
        }
      }
    } catch (error) {
      logger.error(formatError(error));
      this.exit(1);
    }
  }

  /**
   * Runs a single watch cycle - fetch, check for changes, regenerate if needed.
   */
  private async runCycle(options: {
    cycleId: number;
    endpoint: string;
    outputPaths: ReturnType<typeof getOutputPaths>;
    logger: ReturnType<typeof createLogger>;
    headers?: Record<string, string>;
  }): Promise<void> {
    const { cycleId, endpoint, outputPaths, logger, headers } = options;
    const startTime = Date.now();

    // Only show cycle separator in debug mode
    if (logger.level === "debug") {
      logSeparator(logger, `Cycle ${cycleId}`);
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

      // Skip if unchanged (debug level - only shown with --debug)
      if (!fetchResult.hasChanged) {
        const durationMs = Date.now() - startTime;
        logger.debug(
          { cycleId, durationMs: formatDuration(durationMs) },
          "No changes detected, skipping generation"
        );
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
        "New spec detected, regenerating..."
      );

      // Run generation
      const result = await generate({
        paths: outputPaths,
        logger,
      });

      logger.info(
        {
          cycleId,
          operations: result.operationCount,
          duration: formatDuration(result.durationMs),
        },
        "Generation completed"
      );
    } catch (error) {
      // Log error but continue watching
      logger.error(
        {
          cycleId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Cycle failed, will retry next interval"
      );
    }
  }

  /**
   * Delays execution for the specified milliseconds.
   * Respects shutdown state for early termination.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Interval to check for early shutdown
      const checkShutdown = setInterval(() => {
        if (this.isShuttingDown) {
          clearTimeout(timer);
          clearInterval(checkShutdown);
          resolve();
        }
      }, 100);

      // Main timeout - clears interval on normal completion to prevent memory leak
      const timer = setTimeout(() => {
        clearInterval(checkShutdown);
        resolve();
      }, ms);
    });
  }
}
