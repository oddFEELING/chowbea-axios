/**
 * Status command - displays current state of config, cache, and generated files.
 * Shows endpoint statistics including method breakdown.
 */

import { access, stat } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { Command, Flags } from "@oclif/core";

import { getOutputPaths, loadConfig } from "../core/config.js";
import { formatError } from "../core/errors.js";
import {
	hasLocalSpec,
	loadCacheMetadata,
	loadLocalSpec,
} from "../core/fetcher.js";
import { createLogger } from "../core/logger.js";
import { getLogLevel } from "../adapters/logger-interface.js";

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
		const INDENT = "              "; // 14 spaces to align under message
		const LABEL_WIDTH = 10;
		const pad = (label: string) => label.padEnd(LABEL_WIDTH);

		const yes = pc.green("yes");
		const no = pc.red("no");
		const missing = pc.red("missing");

		console.log();
		console.log(`  ${pc.bold("chowbea-axios status")}`);
		console.log();

		// Config section
		console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("config")))}${info.configPath}${info.wasCreated ? pc.yellow(" (created)") : ""}`);
		console.log(`${INDENT}${pc.dim("endpoint:")} ${pc.cyan(info.endpoint)}`);
		console.log(`${INDENT}${pc.dim("output:")} ${pc.cyan(info.outputFolder)}`);
		console.log();

		// Spec section
		if (info.specExists && info.cacheMetadata) {
			const cachedAgo = this.formatTimeAgo(
				new Date(info.cacheMetadata.timestamp)
			);
			console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("spec")))}${pc.dim("cached:")} ${yes} ${pc.dim(`(hash: ${info.cacheMetadata.hash.slice(0, 8)}, ${cachedAgo})`)}`);
		} else if (info.specExists) {
			console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("spec")))}${pc.dim("cached:")} ${yes} ${pc.dim("(no metadata)")}`);
		} else {
			console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("spec")))}${pc.dim("cached:")} ${no} ${pc.dim("- run 'chowbea-axios fetch' first")}`);
		}

		// Endpoint statistics
		if (info.methodCounts && info.methodCounts.total > 0) {
			console.log(`${INDENT}${pc.dim("endpoints:")} ${pc.yellow(String(info.methodCounts.total))} total`);
			const methods: string[] = [];
			if (info.methodCounts.get > 0)
				methods.push(`GET: ${pc.yellow(String(info.methodCounts.get))}`);
			if (info.methodCounts.post > 0)
				methods.push(`POST: ${pc.yellow(String(info.methodCounts.post))}`);
			if (info.methodCounts.put > 0)
				methods.push(`PUT: ${pc.yellow(String(info.methodCounts.put))}`);
			if (info.methodCounts.delete > 0)
				methods.push(`DELETE: ${pc.yellow(String(info.methodCounts.delete))}`);
			if (info.methodCounts.patch > 0)
				methods.push(`PATCH: ${pc.yellow(String(info.methodCounts.patch))}`);
			console.log(`${INDENT}${methods.join("  ")}`);
		}
		console.log();

		// Generated files section
		const { types, operations } = info.fileStatus;
		console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("generated")))}${pc.dim("types:")} ${types.exists ? `${yes} ${pc.dim(`(${types.modifiedAgo})`)}` : no}`);
		console.log(`${INDENT}${pc.dim("operations:")} ${operations.exists ? `${yes} ${pc.dim(`(${operations.modifiedAgo})`)}` : no}`);
		console.log();

		// Client files section
		const clientFiles = ["helpers", "instance", "error", "client"];
		const allPresent = clientFiles.every((f) => info.fileStatus[f]?.exists);
		const nonePresent = clientFiles.every((f) => !info.fileStatus[f]?.exists);

		if (allPresent) {
			console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("client")))}all present`);
		} else if (nonePresent) {
			console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("client")))}${missing} ${pc.dim("- run 'chowbea-axios init' or 'chowbea-axios generate'")}`);
		} else {
			let first = true;
			for (const file of clientFiles) {
				const status = info.fileStatus[file];
				const value = status?.exists ? `${yes} ${pc.dim(`(${status.modifiedAgo})`)}` : missing;
				if (first) {
					console.log(`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("client")))}${file}: ${value}`);
					first = false;
				} else {
					console.log(`${INDENT}${file}: ${value}`);
				}
			}
		}

		console.log();
	}
}
