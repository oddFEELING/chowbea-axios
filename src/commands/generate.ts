/**
 * Generate command - generates TypeScript types and operations from local OpenAPI spec.
 * Auto-creates config if missing and ensures output directories exist.
 */

import { writeFile } from "node:fs/promises";
import { Command, Flags } from "@oclif/core";

import {
	ensureOutputFolders,
	getOutputPaths,
	loadConfig,
	resolveSpecSource,
} from "../lib/config.js";
import { formatError, SpecNotFoundError } from "../lib/errors.js";
import {
	computeHash,
	hasLocalSpec,
	loadLocalSpec,
	saveCacheMetadata,
} from "../lib/fetcher.js";
import { generate, generateClientFiles } from "../lib/generator.js";
import {
	createLogger,
	formatDuration,
	getLogLevel,
	logSeparator,
} from "../lib/logger.js";

/**
 * Generate TypeScript types and operations from local OpenAPI spec.
 */
export default class Generate extends Command {
	static override description =
		`Generate TypeScript types and operations from cached spec.

Uses the locally cached openapi.json (from a previous fetch).
Run 'fetch' first if you don't have a cached spec.

Generates:
- api.types.ts   - TypeScript types from OpenAPI schemas
- api.operations.ts - Typed operation functions`;

	static override examples = [
		{
			command: "<%= config.bin %> generate",
			description: "Regenerate from cached spec",
		},
		{
			command: "<%= config.bin %> generate --dry-run",
			description: "Preview what would be generated",
		},
		{
			command: "<%= config.bin %> generate --types-only",
			description: "Generate only api.types.ts",
		},
		{
			command: "<%= config.bin %> generate --operations-only",
			description: "Generate only api.operations.ts",
		},
		{
			command: "<%= config.bin %> generate --spec-file ./openapi.json",
			description: "Generate from specific local file",
		},
	];

	static override flags = {
		config: Flags.string({
			char: "c",
			description: "Path to api.config.toml",
		}),
		"spec-file": Flags.string({
			char: "s",
			description: "Use local spec file (copies to cache before generating)",
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
		const { flags } = await this.parse(Generate);

		// Create logger with appropriate level
		const logger = createLogger({
			level: getLogLevel(flags),
		});

		logSeparator(logger, "chowbea-axios generate");

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

			// Handle --spec-file flag: copy local spec to cache location
			const specFile = flags["spec-file"];
			if (specFile) {
				const specSource = resolveSpecSource(config, projectRoot, specFile);
				if (specSource.type === "local") {
					logger.info(
						{ specFile: specSource.path },
						"Loading local spec file..."
					);

					// Load and validate the spec
					const { buffer } = await loadLocalSpec(specSource.path);
					const hash = computeHash(buffer);

					// Copy to cache location
					await writeFile(outputPaths.spec, buffer);
					await saveCacheMetadata(outputPaths.cache, {
						hash,
						timestamp: Date.now(),
						endpoint: specSource.path,
					});

					logger.info(
						{ bytes: buffer.length, hash: hash.slice(0, 8) },
						"Spec copied to cache"
					);
				}
			}

			// Check if local spec exists
			const specExists = await hasLocalSpec(outputPaths.spec);

			if (!specExists) {
				throw new SpecNotFoundError(outputPaths.spec);
			}

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
				"Generation completed successfully"
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
