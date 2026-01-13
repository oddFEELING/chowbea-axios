/**
 * Fetch command - fetches OpenAPI spec from remote endpoint and generates types.
 * Includes retry logic and caching to skip regeneration when spec hasn't changed.
 */

import { Command, Flags } from "@oclif/core";

import {
	ensureOutputFolders,
	getOutputPaths,
	loadConfig,
	resolveSpecSource,
} from "../lib/config.js";
import { formatError } from "../lib/errors.js";
import {
	fetchOpenApiSpec,
	loadLocalSpecFile,
	saveSpec,
} from "../lib/fetcher.js";
import { generate, generateClientFiles } from "../lib/generator.js";
import {
	createLogger,
	formatDuration,
	getLogLevel,
	logSeparator,
} from "../lib/logger.js";

/**
 * Fetch OpenAPI spec from remote endpoint and generate types.
 */
export default class Fetch extends Command {
	static override description =
		`Fetch OpenAPI spec and generate TypeScript types + operations.

Downloads the spec from your configured endpoint (or local file),
caches it, and generates api.types.ts and api.operations.ts.

Skips regeneration if spec hasn't changed (use --force to override).
Falls back to cached spec on network failure.`;

	static override examples = [
		{
			command: "<%= config.bin %> fetch",
			description: "Fetch from configured endpoint, generate if changed",
		},
		{
			command: "<%= config.bin %> fetch --force",
			description: "Force regeneration even if spec unchanged",
		},
		{
			command: "<%= config.bin %> fetch --spec-file ./openapi.json",
			description: "Use local spec file instead of remote",
		},
		{
			command: "<%= config.bin %> fetch --dry-run",
			description: "Preview what would be generated",
		},
		{
			command: "<%= config.bin %> fetch --types-only",
			description: "Generate only TypeScript types",
		},
	];

	static override flags = {
		config: Flags.string({
			char: "c",
			description: "Path to api.config.toml",
		}),
		endpoint: Flags.string({
			char: "e",
			description: "Override API endpoint URL",
		}),
		"spec-file": Flags.string({
			char: "s",
			description: "Use local spec file instead of fetching from remote",
		}),
		force: Flags.boolean({
			char: "f",
			description: "Force regeneration even if spec hasn't changed",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Show what would be generated without writing files",
			default: false,
		}),
		"types-only": Flags.boolean({
			description: "Generate only TypeScript types (skip operations)",
			default: false,
		}),
		"operations-only": Flags.boolean({
			description: "Generate only operations (skip types)",
			default: false,
		}),
		quiet: Flags.boolean({
			char: "q",
			description: "Suppress non-error output",
			default: false,
		}),
		verbose: Flags.boolean({
			char: "v",
			description: "Show detailed output",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Fetch);

		// Create logger with appropriate level
		const logger = createLogger({
			level: getLogLevel(flags),
		});

		logSeparator(logger, "chowbea-axios fetch");

		try {
			// Load configuration (auto-creates if missing)
			logger.info("Loading configuration...");
			const { config, projectRoot, configPath, wasCreated } = await loadConfig(
				flags.config
			);

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
			logger.debug({ folder: outputPaths.folder }, "Output folders ready");

			// Resolve spec source (flag > config spec_file > config api_endpoint)
			// Note: --endpoint flag overrides spec_file for remote fetching
			const specFile = flags["spec-file"];
			const specSource = flags.endpoint
				? { type: "remote" as const, endpoint: flags.endpoint }
				: resolveSpecSource(config, projectRoot, specFile);

			let fetchResult;
			let sourceIdentifier: string;

			if (specSource.type === "local") {
				// Load from local file
				sourceIdentifier = specSource.path;
				fetchResult = await loadLocalSpecFile({
					localPath: specSource.path,
					specPath: outputPaths.spec,
					cachePath: outputPaths.cache,
					logger,
					force: flags.force,
				});
			} else {
				// Fetch from remote endpoint
				sourceIdentifier = specSource.endpoint;
				logger.info(
					{ endpoint: specSource.endpoint },
					"Fetching OpenAPI spec..."
				);

				fetchResult = await fetchOpenApiSpec({
					endpoint: specSource.endpoint,
					specPath: outputPaths.spec,
					cachePath: outputPaths.cache,
					logger,
					force: flags.force,
					headers: config.fetch?.headers,
				});

				// Handle network fallback
				if (fetchResult.fromCache) {
					logger.warn("Using cached spec due to network issues");
				}
			}

			if (!(fetchResult.hasChanged || flags.force)) {
				logger.info("Spec unchanged, skipping generation");
				logger.info("Use --force to regenerate anyway");
				return;
			}

			// Save the new spec
			await saveSpec({
				buffer: fetchResult.buffer,
				hash: fetchResult.hash,
				endpoint: sourceIdentifier,
				specPath: outputPaths.spec,
				cachePath: outputPaths.cache,
			});

			logger.info(
				{
					bytes: fetchResult.buffer.length,
					hash: fetchResult.hash.slice(0, 8),
				},
				"Spec saved"
			);

			// Generate client files if they don't exist
			const clientFiles = await generateClientFiles({
				paths: outputPaths,
				instanceConfig: config.instance,
				logger,
			});

			// Validate flag combination
			if (flags["types-only"] && flags["operations-only"]) {
				logger.error("Cannot use --types-only and --operations-only together");
				this.exit(1);
			}

			// Run generation
			logger.info("Starting type and operation generation...");
			const result = await generate({
				paths: outputPaths,
				logger,
				dryRun: flags["dry-run"],
				skipTypes: flags["operations-only"],
				skipOperations: flags["types-only"],
			});

			// Handle dry-run output
			if (flags["dry-run"] && result.dryRunResult) {
				logSeparator(logger);
				logger.info("Dry run complete - no files written");
				logger.info(
					{ operations: result.dryRunResult.operationCount },
					"Operations found"
				);
				for (const file of result.dryRunResult.files) {
					const info = file.lines > 0 ? ` (${file.lines} lines)` : " (types)";
					logger.info(`Would ${file.action}: ${file.path}${info}`);
				}
				return;
			}

			// Report success
			logSeparator(logger);
			logger.info(
				{
					operations: result.operationCount,
					duration: formatDuration(result.durationMs),
				},
				"Fetch and generation completed successfully"
			);
			if (result.typesGenerated) {
				logger.info({ types: outputPaths.types }, "Types output");
			}
			if (result.operationsGenerated) {
				logger.info(
					{ operations: outputPaths.operations },
					"Operations output"
				);
			}

			if (
				clientFiles.helpers ||
				clientFiles.instance ||
				clientFiles.error ||
				clientFiles.client
			) {
				logger.info("Client files created:");
				if (clientFiles.helpers) logger.info(`  - ${outputPaths.helpers}`);
				if (clientFiles.instance) logger.info(`  - ${outputPaths.instance}`);
				if (clientFiles.error) logger.info(`  - ${outputPaths.error}`);
				if (clientFiles.client) logger.info(`  - ${outputPaths.client}`);
			}
		} catch (error) {
			logger.error(formatError(error));
			this.exit(1);
		}
	}
}
