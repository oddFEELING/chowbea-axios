/**
 * Diff action - compares current vs new spec and returns structured changes.
 * Returns diff data for UI rendering; does not print anything.
 */

import { createHash } from "node:crypto";

import type { Logger } from "../../adapters/logger-interface.js";
import {
	ensureOutputFolder,
	getOutputPaths,
	loadConfig,
	resolveSpecSource,
} from "../config.js";
import { formatError, SpecNotFoundError } from "../errors.js";
import {
	computeHash,
	fetchOpenApiSpec,
	hasLocalSpec,
	loadCacheMetadata,
	loadLocalSpec,
} from "../fetcher.js";
import { HTTP_METHODS } from "../http-methods.js";

/**
 * Options for the diff action.
 */
export interface DiffActionOptions {
	configPath?: string;
	specFile?: string;
}

/**
 * Operation metadata for comparison.
 *
 * `signatureHash` is a SHA-256 over a canonicalized projection of the
 * operation's structural shape (parameters, request body content,
 * response statuses + content schemas, deprecation, security). Two
 * operations with the same signatureHash are guaranteed identical for
 * diff purposes — schema/parameter/response changes flip the hash even
 * when the surface fields (method, path, summary) stay the same. Issue
 * #30.
 */
export interface OperationInfo {
	operationId: string;
	method: string;
	path: string;
	hasRequestBody: boolean;
	summary: string;
	signatureHash: string;
}

/**
 * Result of the diff action.
 */
export interface DiffResult {
	added: OperationInfo[];
	removed: OperationInfo[];
	modified: Array<{ old: OperationInfo; new: OperationInfo }>;
	identical: boolean;
	currentSpecHash?: string;
	newSpecHash: string;
}

/**
 * Returns a stable, canonical-JSON projection of the operation's
 * structural shape — the inputs that actually affect the generated
 * client. Used as the input to `signatureHash`. Issue #30.
 */
function canonicalizeOperationShape(
	operation: Record<string, unknown>,
): unknown {
	const stable = (v: unknown): unknown => {
		if (v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map(stable);
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(v as Record<string, unknown>).sort()) {
			sorted[key] = stable((v as Record<string, unknown>)[key]);
		}
		return sorted;
	};

	return stable({
		// Surface fields kept on top so the hash also flips on path/method
		// changes, matching the prior behavior.
		method: operation.method ?? "",
		// Structural fields that the prior implementation missed entirely.
		parameters: operation.parameters ?? null,
		requestBody: operation.requestBody ?? null,
		responses: operation.responses ?? null,
		deprecated: operation.deprecated ?? false,
		security: operation.security ?? null,
	});
}

/**
 * Extracts operations from an OpenAPI spec, including a canonical
 * `signatureHash` per operation that captures parameter/body/response
 * shape — not just method/path/summary like before. Issue #30.
 */
export function extractOperations(spec: unknown): Map<string, OperationInfo> {
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
		// Walk all 8 HTTP methods so additions/removals of HEAD/OPTIONS/
		// TRACE operations show up in the diff. Issue #31.
		for (const method of HTTP_METHODS) {
			const operation = pathItem[method] as
				| Record<string, unknown>
				| undefined;

			if (!(operation && operation.operationId)) continue;

			const operationId = operation.operationId as string;

			const shape = canonicalizeOperationShape({
				...operation,
				method,
			});
			const signatureHash = createHash("sha256")
				.update(JSON.stringify(shape))
				.digest("hex");

			operations.set(operationId, {
				operationId,
				method,
				path: pathTemplate,
				hasRequestBody: Boolean(operation.requestBody),
				summary: (operation.summary as string) ?? "",
				signatureHash,
			});
		}
	}

	return operations;
}

/**
 * Checks if two operations have meaningful differences.
 *
 * The previous implementation compared only `method/path/hasRequestBody/
 * summary`, which missed schema, parameter, and response changes — a
 * spec drift that breaks the generated client could be reported as
 * "identical". Now the comparison is driven by `signatureHash`, which
 * folds in every structural input. Issue #30.
 */
export function hasChanges(a: OperationInfo, b: OperationInfo): boolean {
	return (
		a.method !== b.method ||
		a.path !== b.path ||
		a.signatureHash !== b.signatureHash
	);
}

/**
 * Executes the diff action: compares current spec with a new one.
 * Returns structured diff data without any UI rendering.
 */
export async function executeDiff(
	options: DiffActionOptions,
	logger: Logger
): Promise<DiffResult> {
	try {
		// Load configuration
		const { config, projectRoot } = await loadConfig(options.configPath);
		const outputPaths = getOutputPaths(config, projectRoot);

		await ensureOutputFolder(outputPaths.folder);

		// Load current spec (if exists)
		const hasCurrentSpec = await hasLocalSpec(outputPaths.spec);
		let currentOperations: Map<string, OperationInfo> = new Map();
		let currentSpecHash: string | undefined;

		if (hasCurrentSpec) {
			const { spec: currentSpec } = await loadLocalSpec(outputPaths.spec);
			currentOperations = extractOperations(currentSpec);
			logger.info(
				{ operations: currentOperations.size },
				"Loaded current spec"
			);

			// Get current spec hash from cache metadata
			const currentCacheMetadata = await loadCacheMetadata(outputPaths.cache);
			if (currentCacheMetadata) {
				currentSpecHash = currentCacheMetadata.hash;
			}
		} else {
			logger.info("No current spec found - will show all as new");
		}

		// Load new spec (from flag or fetch)
		let newSpec: unknown;
		let newHash: string;

		const specSource = resolveSpecSource(
			config,
			projectRoot,
			options.specFile,
		);

		if (specSource.type === "local") {
			// Load from local path (CLI flag or config.spec_file)
			const result = await loadLocalSpec(specSource.path);
			newSpec = result.spec;
			newHash = computeHash(result.buffer);
			logger.info({ spec: specSource.path }, "Loaded new spec from file");
		} else {
			// Fetch from remote
			logger.info(
				{ endpoint: specSource.endpoint },
				"Fetching new spec from endpoint..."
			);

			const fetchResult = await fetchOpenApiSpec({
				endpoint: specSource.endpoint,
				specPath: outputPaths.spec,
				cachePath: outputPaths.cache,
				logger,
				force: true, // Always fetch fresh for diff
			});

			newSpec = JSON.parse(fetchResult.buffer.toString("utf8"));
			newHash = fetchResult.hash;
		}

		// Check hash against cache for identical detection (reuse already-loaded metadata)
		if (currentSpecHash && currentSpecHash === newHash && !options.specFile) {
			return {
				added: [],
				removed: [],
				modified: [],
				identical: true,
				currentSpecHash,
				newSpecHash: newHash,
			};
		}

		// Extract operations from new spec
		const newOperations = extractOperations(newSpec);
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
			} else if (hasChanges(currentOp, newOp)) {
				modified.push({ old: currentOp, new: newOp });
			}
		}

		// Find removed operations
		for (const [id, currentOp] of currentOperations) {
			if (!newOperations.has(id)) {
				removed.push(currentOp);
			}
		}

		const identical =
			added.length === 0 && removed.length === 0 && modified.length === 0;

		return {
			added,
			removed,
			modified,
			identical,
			currentSpecHash,
			newSpecHash: newHash,
		};
	} catch (error) {
		if (error instanceof SpecNotFoundError) {
			logger.warn("No local spec found - nothing to compare against");
			throw error;
		}

		logger.error(formatError(error));
		throw error;
	}
}
