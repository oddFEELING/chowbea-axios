/**
 * Config management actions for the Settings screen.
 * Provides save/update/action functions that the SettingsMode component uses.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	ensureOutputFolders,
	findProjectRoot,
	generateConfigTemplate,
	getConfigPath,
	getOutputPaths,
	loadConfig,
	type ApiConfig,
} from "../config.js";
import { generateClientFiles } from "../generator.js";
import type { Logger } from "../../adapters/logger-interface.js";

// ---------------------------------------------------------------------------
// Default npm scripts (mirrors init.ts DEFAULT_SCRIPTS)
// ---------------------------------------------------------------------------

const DEFAULT_SCRIPTS: Record<string, string> = {
	"api:generate": "chowbea-axios generate",
	"api:fetch": "chowbea-axios fetch",
	"api:watch": "chowbea-axios watch",
	"api:status": "chowbea-axios status",
	"api:validate": "chowbea-axios validate",
	"api:diff": "chowbea-axios diff",
};

// ---------------------------------------------------------------------------
// Save config
// ---------------------------------------------------------------------------

/**
 * Writes an ApiConfig to disk as TOML.
 */
export async function saveConfig(
	configPath: string,
	config: ApiConfig,
): Promise<void> {
	const toml = generateConfigTemplate(config);
	await writeFile(configPath, toml, "utf8");
}

// ---------------------------------------------------------------------------
// Load current config
// ---------------------------------------------------------------------------

/**
 * Loads the current config, returning the parsed config plus paths.
 */
export async function loadCurrentConfig(): Promise<{
	config: ApiConfig;
	configPath: string;
	projectRoot: string;
}> {
	const projectRoot = await findProjectRoot();
	const configPath = getConfigPath(projectRoot);
	const { config } = await loadConfig(configPath);
	return { config, configPath, projectRoot };
}

// ---------------------------------------------------------------------------
// Regenerate client files
// ---------------------------------------------------------------------------

/**
 * Regenerates the client files (api.instance.ts, api.error.ts, api.client.ts,
 * api.helpers.ts) using the current config. Forces overwrite.
 */
export async function regenerateClientFiles(
	logger: Logger,
): Promise<{ helpers: boolean; instance: boolean; error: boolean; client: boolean }> {
	const projectRoot = await findProjectRoot();
	const configPath = getConfigPath(projectRoot);
	const { config } = await loadConfig(configPath);
	const outputPaths = getOutputPaths(config, projectRoot);

	await ensureOutputFolders(outputPaths);

	const result = await generateClientFiles({
		paths: outputPaths,
		instanceConfig: config.instance,
		logger,
		force: true,
	});

	return result;
}

// ---------------------------------------------------------------------------
// Sync npm scripts
// ---------------------------------------------------------------------------

/**
 * Reads package.json, adds/updates the 6 api:* scripts, writes back.
 * Returns arrays of added and updated script names.
 */
export async function syncScripts(): Promise<{
	added: string[];
	updated: string[];
}> {
	const projectRoot = await findProjectRoot();
	const packageJsonPath = path.join(projectRoot, "package.json");

	const content = await readFile(packageJsonPath, "utf8");
	const packageJson = JSON.parse(content) as Record<string, unknown>;

	if (!packageJson.scripts || typeof packageJson.scripts !== "object") {
		packageJson.scripts = {};
	}

	const scripts = packageJson.scripts as Record<string, string>;

	const added: string[] = [];
	const updated: string[] = [];

	for (const [name, command] of Object.entries(DEFAULT_SCRIPTS)) {
		if (!(name in scripts)) {
			scripts[name] = command;
			added.push(name);
		} else if (scripts[name] !== command) {
			scripts[name] = command;
			updated.push(name);
		}
	}

	if (added.length > 0 || updated.length > 0) {
		await writeFile(
			packageJsonPath,
			JSON.stringify(packageJson, null, 2) + "\n",
			"utf8",
		);
	}

	return { added, updated };
}
