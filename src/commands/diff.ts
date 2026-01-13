/**
 * Diff command - compares current vs new spec and shows changes.
 * Useful for previewing what would change before regenerating.
 */

import { Command, Flags } from "@oclif/core";

import {
	ensureOutputFolder,
	getOutputPaths,
	loadConfig,
} from "../lib/config.js";
import { formatError, SpecNotFoundError } from "../lib/errors.js";
import {
	computeHash,
	fetchOpenApiSpec,
	hasLocalSpec,
	loadCacheMetadata,
	loadLocalSpec,
} from "../lib/fetcher.js";
import { createLogger, getLogLevel, logSeparator } from "../lib/logger.js";

/**
 * Operation metadata for comparison.
 */
interface OperationInfo {
	operationId: string;
	method: string;
	path: string;
	hasRequestBody: boolean;
	summary: string;
}

/**
 * Compare current vs new spec and show changes.
 */
export default class Diff extends Command {
	static override description = `Preview API changes before regenerating.

Compares your cached spec with the remote (or a local file) and shows:
- New endpoints added
- Endpoints removed
- Endpoints modified

Useful to see what changed before running fetch.`;

	static override examples = [
		{
			command: "<%= config.bin %> diff",
			description: "Compare cached spec with remote endpoint",
		},
		{
			command: "<%= config.bin %> diff --spec ./new-openapi.json",
			description: "Compare cached spec with local file",
		},
	];

	static override flags = {
		config: Flags.string({
			char: "c",
			description: "Path to api.config.toml",
		}),
		spec: Flags.string({
			char: "s",
			description: "Path to new OpenAPI spec file to compare against",
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
		const { flags } = await this.parse(Diff);

		// Create logger with appropriate level
		const logger = createLogger({
			level: getLogLevel(flags),
		});

		logSeparator(logger, "chowbea-axios diff");

		try {
			// Load configuration
			const { config, projectRoot } = await loadConfig(flags.config);
			const outputPaths = getOutputPaths(config, projectRoot);

			await ensureOutputFolder(outputPaths.folder);

			// Load current spec (if exists)
			const hasCurrentSpec = await hasLocalSpec(outputPaths.spec);
			let currentOperations: Map<string, OperationInfo> = new Map();

			if (hasCurrentSpec) {
				const { spec: currentSpec } = await loadLocalSpec(outputPaths.spec);
				currentOperations = this.extractOperations(currentSpec);
				logger.info(
					{ operations: currentOperations.size },
					"Loaded current spec"
				);
			} else {
				logger.info("No current spec found - will show all as new");
			}

			// Load new spec (from flag or fetch)
			let newSpec: unknown;
			let newHash: string;

			if (flags.spec) {
				// Load from provided file
				const result = await loadLocalSpec(flags.spec);
				newSpec = result.spec;
				newHash = computeHash(result.buffer);
				logger.info({ spec: flags.spec }, "Loaded new spec from file");
			} else {
				// Fetch from remote
				logger.info(
					{ endpoint: config.api_endpoint },
					"Fetching new spec from endpoint..."
				);

				const fetchResult = await fetchOpenApiSpec({
					endpoint: config.api_endpoint,
					specPath: outputPaths.spec,
					cachePath: outputPaths.cache,
					logger,
					force: true, // Always fetch fresh for diff
				});

				newSpec = JSON.parse(fetchResult.buffer.toString("utf8"));
				newHash = fetchResult.hash;
			}

			// Check hash against cache
			const cacheMetadata = await loadCacheMetadata(outputPaths.cache);

			if (cacheMetadata && cacheMetadata.hash === newHash && !flags.spec) {
				logger.info("Spec is identical to cached version - no changes");
				return;
			}

			// Extract operations from new spec
			const newOperations = this.extractOperations(newSpec);
			logger.info({ operations: newOperations.size }, "Analyzed new spec");

			// Compute differences
			const added: OperationInfo[] = [];
			const removed: OperationInfo[] = [];
			const modified: Array<{ old: OperationInfo; new: OperationInfo }> = [];

			// Find added and modified operations
			for (const [id, newOp] of newOperations) {
				const currentOp = currentOperations.get(id);

				if (!currentOp) {
					added.push(newOp);
				} else if (this.hasChanges(currentOp, newOp)) {
					modified.push({ old: currentOp, new: newOp });
				}
			}

			// Find removed operations
			for (const [id, currentOp] of currentOperations) {
				if (!newOperations.has(id)) {
					removed.push(currentOp);
				}
			}

			// Report changes
			logSeparator(logger, "Changes Summary");

			if (added.length === 0 && removed.length === 0 && modified.length === 0) {
				logger.info("No changes to operations detected");
				return;
			}

			if (added.length > 0) {
				logger.info(`\n+ Added operations (${added.length}):`);
				for (const op of added) {
					logger.info(
						`  + ${op.method.toUpperCase()} ${op.path} (${op.operationId})`
					);
				}
			}

			if (removed.length > 0) {
				logger.info(`\n- Removed operations (${removed.length}):`);
				for (const op of removed) {
					logger.info(
						`  - ${op.method.toUpperCase()} ${op.path} (${op.operationId})`
					);
				}
			}

			if (modified.length > 0) {
				logger.info(`\n~ Modified operations (${modified.length}):`);
				for (const { old: oldOp, new: newOp } of modified) {
					logger.info(
						`  ~ ${newOp.method.toUpperCase()} ${newOp.path} (${newOp.operationId})`
					);
					if (oldOp.hasRequestBody !== newOp.hasRequestBody) {
						logger.info(
							`    Request body: ${oldOp.hasRequestBody} -> ${newOp.hasRequestBody}`
						);
					}
					if (oldOp.summary !== newOp.summary) {
						logger.info("    Summary changed");
					}
				}
			}

			logSeparator(logger);
			logger.info(
				{
					added: added.length,
					removed: removed.length,
					modified: modified.length,
				},
				"Total changes"
			);
			logger.info("\nRun 'chowbea-axios fetch' to apply these changes");
		} catch (error) {
			if (error instanceof SpecNotFoundError) {
				logger.warn("No local spec found - nothing to compare against");
				logger.info("Run 'chowbea-axios fetch' first to download the spec");
				return;
			}

			logger.error(formatError(error));
			this.exit(1);
		}
	}

	/**
	 * Extracts operations from an OpenAPI spec.
	 */
	private extractOperations(spec: unknown): Map<string, OperationInfo> {
		const operations = new Map<string, OperationInfo>();

		if (typeof spec !== "object" || spec === null) {
			return operations;
		}

		const specObj = spec as Record<string, unknown>;
		const paths = specObj.paths as
			| Record<string, Record<string, unknown>>
			| undefined;

		if (!paths) {
			return operations;
		}

		for (const [pathTemplate, pathItem] of Object.entries(paths)) {
			for (const method of ["get", "post", "put", "delete", "patch"]) {
				const operation = pathItem[method] as
					| Record<string, unknown>
					| undefined;

				if (!(operation && operation.operationId)) continue;

				const operationId = operation.operationId as string;

				operations.set(operationId, {
					operationId,
					method,
					path: pathTemplate,
					hasRequestBody: Boolean(operation.requestBody),
					summary: (operation.summary as string) ?? "",
				});
			}
		}

		return operations;
	}

	/**
	 * Checks if two operations have meaningful differences.
	 */
	private hasChanges(a: OperationInfo, b: OperationInfo): boolean {
		return (
			a.method !== b.method ||
			a.path !== b.path ||
			a.hasRequestBody !== b.hasRequestBody ||
			a.summary !== b.summary
		);
	}
}
