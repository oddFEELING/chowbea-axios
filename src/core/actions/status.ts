/**
 * Status action - gathers current state of config, cache, and generated files.
 * Returns structured data for UI rendering; does not print anything.
 */

import { access, stat } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { getOutputPaths, loadConfig } from "../config.js";
import type { OutputPaths } from "../config.js";
import { formatError } from "../errors.js";
import { hasLocalSpec, loadCacheMetadata, loadLocalSpec } from "../fetcher.js";
import type { CacheMetadata } from "../fetcher.js";

/**
 * Options for the status action.
 */
export interface StatusActionOptions {
	configPath?: string;
}

/**
 * HTTP method counts for endpoint statistics.
 */
export interface MethodCounts {
	get: number;
	post: number;
	put: number;
	delete: number;
	patch: number;
	total: number;
}

/**
 * File existence and modification status.
 */
export type FileStatus = Record<string, { exists: boolean; modifiedAgo?: string }>;

/**
 * Result of the status action.
 */
export interface StatusResult {
	configPath: string;
	wasCreated: boolean;
	endpoint: string;
	outputFolder: string;
	cacheMetadata: CacheMetadata | null;
	specExists: boolean;
	methodCounts: MethodCounts | null;
	fileStatus: FileStatus;
	projectRoot: string;
}

/**
 * Formats a date as a relative time string (e.g., "5s ago", "2h ago").
 */
export function formatTimeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Counts endpoints by HTTP method from the OpenAPI spec.
 */
export async function countEndpoints(specPath: string): Promise<MethodCounts> {
	const counts: MethodCounts = {
		get: 0,
		post: 0,
		put: 0,
		delete: 0,
		patch: 0,
		total: 0,
	};

	try {
		const { spec } = await loadLocalSpec(specPath);
		const specObj = spec as Record<string, unknown>;
		const paths = specObj.paths as Record<string, Record<string, unknown>>;

		if (!paths) return counts;

		for (const pathItem of Object.values(paths)) {
			if (typeof pathItem !== "object" || pathItem === null) continue;

			for (const method of [
				"get",
				"post",
				"put",
				"delete",
				"patch",
			] as const) {
				if (pathItem[method]) {
					counts[method]++;
					counts.total++;
				}
			}
		}
	} catch {
		// Return zero counts on error
	}

	return counts;
}

/**
 * Checks which generated files exist and their modification times.
 */
export async function checkGeneratedFiles(
	outputPaths: Pick<OutputPaths, "types" | "operations" | "helpers" | "instance" | "error" | "client">
): Promise<FileStatus> {
	const files = {
		types: outputPaths.types,
		operations: outputPaths.operations,
		helpers: outputPaths.helpers,
		instance: outputPaths.instance,
		error: outputPaths.error,
		client: outputPaths.client,
	};

	const status: FileStatus = {};

	for (const [name, filePath] of Object.entries(files)) {
		try {
			await access(filePath);
			const stats = await stat(filePath);
			status[name] = {
				exists: true,
				modifiedAgo: formatTimeAgo(stats.mtime),
			};
		} catch {
			status[name] = { exists: false };
		}
	}

	return status;
}

/**
 * Executes the status action: gathers config, cache, spec, and file status.
 * Returns structured data without any UI rendering.
 */
export async function executeStatus(
	options: StatusActionOptions,
	logger: Logger
): Promise<StatusResult> {
	try {
		// Load configuration
		const { config, projectRoot, configPath, wasCreated } = await loadConfig(
			options.configPath
		);

		// Get output paths
		const outputPaths = getOutputPaths(config, projectRoot);

		// Gather all status info
		const cacheMetadata = await loadCacheMetadata(outputPaths.cache);
		const specExists = await hasLocalSpec(outputPaths.spec);
		const methodCounts = specExists
			? await countEndpoints(outputPaths.spec)
			: null;
		const fileStatus = await checkGeneratedFiles(outputPaths);

		return {
			configPath: path.relative(projectRoot, configPath),
			wasCreated,
			endpoint: config.api_endpoint,
			outputFolder: config.output.folder,
			cacheMetadata,
			specExists,
			methodCounts,
			fileStatus,
			projectRoot,
		};
	} catch (error) {
		logger.error(formatError(error));
		throw error;
	}
}
