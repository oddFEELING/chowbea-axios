/**
 * Status command - displays current state of config, cache, and generated files.
 * Shows endpoint statistics including method breakdown.
 */

import { access, stat } from "node:fs/promises";
import path from "node:path";
import { Command, Flags } from "@oclif/core";

import { getOutputPaths, loadConfig } from "../lib/config.js";
import { formatError } from "../lib/errors.js";
import {
	hasLocalSpec,
	loadCacheMetadata,
	loadLocalSpec,
} from "../lib/fetcher.js";
import { createLogger, getLogLevel } from "../lib/logger.js";

/**
 * HTTP method counts for endpoint statistics.
 */
interface MethodCounts {
	get: number;
	post: number;
	put: number;
	delete: number;
	patch: number;
	total: number;
}

/**
 * Display current status of config, cache, and generated files.
 */
export default class Status extends Command {
	static override description = `Show current state of your API client setup.

Displays:
- Config file location and settings
- Cached spec info (hash, age)
- Endpoint statistics (total count, breakdown by HTTP method)
- Generated file status (types, operations, client files)`;

	static override examples = [
		{
			command: "<%= config.bin %> status",
			description: "Show full status overview",
		},
	];

	static override flags = {
		config: Flags.string({
			char: "c",
			description: "Path to api.config.toml",
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
		const { flags } = await this.parse(Status);

		// Create logger (only used for errors in status command)
		const logger = createLogger({
			level: getLogLevel(flags),
		});

		try {
			// Load configuration
			const { config, projectRoot, configPath, wasCreated } = await loadConfig(
				flags.config
			);

			// Get output paths
			const outputPaths = getOutputPaths(config, projectRoot);

			// Gather all status info
			const cacheMetadata = await loadCacheMetadata(outputPaths.cache);
			const specExists = await hasLocalSpec(outputPaths.spec);
			const methodCounts = specExists
				? await this.countEndpoints(outputPaths.spec)
				: null;
			const fileStatus = await this.checkGeneratedFiles(outputPaths);

			// Print status
			this.printStatus({
				configPath: path.relative(projectRoot, configPath),
				wasCreated,
				endpoint: config.api_endpoint,
				outputFolder: config.output.folder,
				cacheMetadata,
				specExists,
				methodCounts,
				fileStatus,
				projectRoot,
			});
		} catch (error) {
			logger.error(formatError(error));
			this.exit(1);
		}
	}

	/**
	 * Counts endpoints by HTTP method from the OpenAPI spec.
	 */
	private async countEndpoints(specPath: string): Promise<MethodCounts> {
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
	private async checkGeneratedFiles(outputPaths: {
		types: string;
		operations: string;
		helpers: string;
		instance: string;
		error: string;
		client: string;
	}): Promise<Record<string, { exists: boolean; modifiedAgo?: string }>> {
		const files = {
			types: outputPaths.types,
			operations: outputPaths.operations,
			helpers: outputPaths.helpers,
			instance: outputPaths.instance,
			error: outputPaths.error,
			client: outputPaths.client,
		};

		const status: Record<string, { exists: boolean; modifiedAgo?: string }> =
			{};

		for (const [name, filePath] of Object.entries(files)) {
			try {
				await access(filePath);
				const stats = await stat(filePath);
				status[name] = {
					exists: true,
					modifiedAgo: this.formatTimeAgo(stats.mtime),
				};
			} catch {
				status[name] = { exists: false };
			}
		}

		return status;
	}

	/**
	 * Formats a date as a relative time string (e.g., "5 min ago", "2h ago").
	 */
	private formatTimeAgo(date: Date): string {
		const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

		if (seconds < 60) return `${seconds}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
		if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86_400)}d ago`;
	}

	/**
	 * Prints the formatted status output.
	 */
	private printStatus(info: {
		configPath: string;
		wasCreated: boolean;
		endpoint: string;
		outputFolder: string;
		cacheMetadata: { hash: string; timestamp: number; endpoint: string } | null;
		specExists: boolean;
		methodCounts: MethodCounts | null;
		fileStatus: Record<string, { exists: boolean; modifiedAgo?: string }>;
		projectRoot: string;
	}): void {
		const line = "─".repeat(50);

		console.log();
		console.log(`╭${line}`);
		console.log("│ Status");
		console.log(`├${line}`);

		// Config section
		console.log("│");
		console.log(
			`│ Config: ${info.configPath}${info.wasCreated ? " (created)" : ""}`
		);
		console.log(`│   endpoint: ${info.endpoint}`);
		console.log(`│   output: ${info.outputFolder}`);

		// Spec section
		console.log("│");
		console.log("│ Spec:");
		if (info.specExists && info.cacheMetadata) {
			const cachedAgo = this.formatTimeAgo(
				new Date(info.cacheMetadata.timestamp)
			);
			console.log(
				`│   cached: yes (hash: ${info.cacheMetadata.hash.slice(0, 8)}, ${cachedAgo})`
			);
		} else if (info.specExists) {
			console.log("│   cached: yes (no metadata)");
		} else {
			console.log("│   cached: no - run 'chowbea-axios fetch' first");
		}

		// Endpoint statistics
		if (info.methodCounts && info.methodCounts.total > 0) {
			console.log(`│   endpoints: ${info.methodCounts.total} total`);
			const methods = [];
			if (info.methodCounts.get > 0)
				methods.push(`GET: ${info.methodCounts.get}`);
			if (info.methodCounts.post > 0)
				methods.push(`POST: ${info.methodCounts.post}`);
			if (info.methodCounts.put > 0)
				methods.push(`PUT: ${info.methodCounts.put}`);
			if (info.methodCounts.delete > 0)
				methods.push(`DELETE: ${info.methodCounts.delete}`);
			if (info.methodCounts.patch > 0)
				methods.push(`PATCH: ${info.methodCounts.patch}`);
			console.log(`│     ${methods.join("  ")}`);
		}

		// Generated files section
		console.log("│");
		console.log("│ Generated:");
		const { types, operations } = info.fileStatus;
		console.log(
			`│   types: ${types.exists ? `yes (${types.modifiedAgo})` : "no"}`
		);
		console.log(
			`│   operations: ${operations.exists ? `yes (${operations.modifiedAgo})` : "no"}`
		);

		// Client files section
		console.log("│");
		console.log("│ Client files:");
		const clientFiles = ["helpers", "instance", "error", "client"];
		const allPresent = clientFiles.every((f) => info.fileStatus[f]?.exists);
		const nonePresent = clientFiles.every((f) => !info.fileStatus[f]?.exists);

		if (allPresent) {
			console.log("│   all present");
		} else if (nonePresent) {
			console.log(
				"│   none - run 'chowbea-axios init' or 'chowbea-axios generate'"
			);
		} else {
			for (const file of clientFiles) {
				const status = info.fileStatus[file];
				console.log(
					`│   ${file}: ${status?.exists ? `yes (${status.modifiedAgo})` : "missing"}`
				);
			}
		}

		console.log(`╰${line}`);
		console.log();
	}
}
