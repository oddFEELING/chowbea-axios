/**
 * Init command - full project setup for chowbea-axios.
 * Creates config, adds workspace entry, adds npm scripts, generates client files,
 * installs dependencies, builds CLI, and runs initial fetch.
 */

import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkbox, confirm, input } from "@inquirer/prompts";
import { Command, Flags } from "@oclif/core";

import {
    configExists,
    DEFAULT_INSTANCE_CONFIG,
    ensureOutputFolders,
    findProjectRoot,
    getConfigPath,
    getOutputPaths,
    type InstanceConfig,
    loadConfig,
} from "../lib/config.js";
import { formatError } from "../lib/errors.js";
import { generateClientFiles } from "../lib/generator.js";
import { createLogger, getLogLevel, logSeparator } from "../lib/logger.js";

/**
 * Default npm scripts to add to package.json
 */
const DEFAULT_SCRIPTS: Record<string, string> = {
	"api:generate": "node cli/chowbea-axios/bin/run.js generate",
	"api:fetch": "node cli/chowbea-axios/bin/run.js fetch",
	"api:watch": "node cli/chowbea-axios/bin/run.js watch",
	"api:init": "node cli/chowbea-axios/bin/run.js init",
	"api:status": "node cli/chowbea-axios/bin/run.js status",
	"api:validate": "node cli/chowbea-axios/bin/run.js validate",
	"api:diff": "node cli/chowbea-axios/bin/run.js diff",
	"api:help": "node cli/chowbea-axios/bin/run.js --help",
};

/**
 * Default pnpm-workspace.yaml content
 */
const DEFAULT_WORKSPACE_YAML = `# pnpm workspace configuration
# Includes the CLI tools as workspace packages
packages:
  - "cli/*"
`;

/**
 * Initialize chowbea-axios in a project.
 * Creates config, workspace file, and npm scripts.
 */
export default class Init extends Command {
	static override description =
		`Full project setup - one command to get started.

Prompts for your API endpoint, then automatically:
- Creates api.config.toml with your settings
- Sets up pnpm workspace for the CLI
- Adds npm scripts (api:fetch, api:generate, etc.)
- Installs openapi-typescript dependency
- Builds the CLI
- Generates client files (api.instance.ts, api.client.ts, etc.)
- Fetches spec and generates types (if not localhost)

Detects existing setup and asks before overwriting.`;

	static override examples = [
		{
			command: "<%= config.bin %> init",
			description: "Interactive setup - prompts for endpoint, does everything",
		},
		{
			command: "<%= config.bin %> init --force",
			description: "Skip confirmations, overwrite existing files",
		},
		{
			command: "<%= config.bin %> init --skip-client",
			description: "Setup without generating client files",
		},
	];

	static override flags = {
		force: Flags.boolean({
			char: "f",
			description: "Skip all confirmations and overwrite everything",
			default: false,
		}),
		"skip-scripts": Flags.boolean({
			description: "Skip adding npm scripts to package.json",
			default: false,
		}),
		"skip-workspace": Flags.boolean({
			description: "Skip creating/updating pnpm-workspace.yaml",
			default: false,
		}),
		"skip-client": Flags.boolean({
			description:
				"Skip generating client files (api.instance.ts, api.error.ts, api.client.ts)",
			default: false,
		}),
		"skip-concurrent": Flags.boolean({
			description: "Skip setting up concurrent dev script",
			default: false,
		}),
		"base-url-env": Flags.string({
			description: "Environment variable name for base URL",
			default: DEFAULT_INSTANCE_CONFIG.base_url_env,
		}),
		"token-key": Flags.string({
			description: "localStorage key for auth token",
			default: DEFAULT_INSTANCE_CONFIG.token_key,
		}),
		"with-credentials": Flags.boolean({
			description: "Include credentials (cookies) in requests",
			default: DEFAULT_INSTANCE_CONFIG.with_credentials,
			allowNo: true,
		}),
		timeout: Flags.integer({
			description: "Request timeout in milliseconds",
			default: DEFAULT_INSTANCE_CONFIG.timeout,
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
		const { flags } = await this.parse(Init);

		// Create logger with appropriate level
		const logger = createLogger({
			level: getLogLevel(flags),
		});

		logSeparator(logger, "chowbea-axios init");

		try {
			// Find project root
			const projectRoot = await findProjectRoot();
			logger.info({ projectRoot }, "Found project root");

			// Check for existing setup and notify user
			const existingSetup = await this.detectExistingSetup(projectRoot);
			if (existingSetup.length > 0 && !flags.force) {
				logger.warn("Existing setup detected:");
				for (const item of existingSetup) {
					logger.warn(`  - ${item}`);
				}
				const shouldContinue = await confirm({
					message: "Continue with setup? (existing files may be modified)",
					default: true,
				});
				if (!shouldContinue) {
					logger.info("Setup cancelled");
					return;
				}
			}

			// Prompt for API endpoint URL
			const apiEndpoint = await input({
				message: "Enter your OpenAPI spec endpoint URL:",
				default: "http://localhost:3000/docs/swagger/json",
			});

			// Build instance config from flags
			const instanceConfig: InstanceConfig = {
				base_url_env: flags["base-url-env"],
				token_key: flags["token-key"],
				with_credentials: flags["with-credentials"],
				timeout: flags.timeout,
			};

			// Step 1: Create api.config.toml
			await this.setupConfig(
				projectRoot,
				flags,
				instanceConfig,
				apiEndpoint,
				logger
			);

			// Step 2: Create/update pnpm-workspace.yaml
			if (!flags["skip-workspace"]) {
				await this.setupWorkspace(projectRoot, flags, logger);
			}

			// Step 3: Add npm scripts to package.json
			if (!flags["skip-scripts"]) {
				await this.setupScripts(projectRoot, flags, logger);
			}

			// Step 3.5: Setup concurrent dev script (optional)
			if (!flags["skip-concurrent"]) {
				await this.setupConcurrentlyScript(projectRoot, logger);
			}

			// Step 4: Check and install openapi-typescript
			await this.ensureOpenApiTypescript(projectRoot, logger);

			// Step 5: Run pnpm install
			await this.runPnpmInstall(projectRoot, logger);

			// Step 6: Build the CLI
			await this.buildCli(projectRoot, logger);

			// Step 7: Generate client files
			if (!flags["skip-client"]) {
				await this.setupClientFiles(projectRoot, instanceConfig, flags, logger);
			}

			// Step 8: Run initial fetch (if not localhost default)
			const isLocalhost =
				apiEndpoint.includes("localhost") || apiEndpoint.includes("127.0.0.1");
			if (!isLocalhost) {
				await this.runInitialFetch(projectRoot, logger);
			}

			// Summary
			logSeparator(logger, "Setup Complete");
			logger.info("");
			if (isLocalhost) {
				logger.info("Setup complete! When your API server is running:");
				logger.info("  pnpm api:fetch    # Fetch spec and generate types");
			} else {
				logger.info("Setup complete! Your API client is ready to use.");
				logger.info("");
				logger.info("Useful commands:");
				logger.info("  pnpm api:status   # Check current status");
				logger.info("  pnpm api:fetch    # Re-fetch spec and regenerate");
				logger.info("  pnpm api:watch    # Watch for spec changes");
			}
			logger.info("");
		} catch (error) {
			logger.error(formatError(error));
			this.exit(1);
		}
	}

	/**
	 * Detects existing setup files to notify user.
	 * Does NOT auto-create any files - only checks what exists.
	 */
	private async detectExistingSetup(projectRoot: string): Promise<string[]> {
		const found: string[] = [];

		// Check for config
		const configPath = getConfigPath(projectRoot);
		const hasConfig = await configExists(configPath);
		if (hasConfig) {
			found.push("api.config.toml");
		}

		// Check for workspace
		try {
			await access(path.join(projectRoot, "pnpm-workspace.yaml"));
			found.push("pnpm-workspace.yaml");
		} catch {
			// Not found
		}

		// Only check for client files if config exists (to avoid auto-creating config)
		if (hasConfig) {
			try {
				const { config } = await loadConfig();
				const outputPaths = getOutputPaths(config, projectRoot);

				try {
					await access(outputPaths.instance);
					found.push("api.instance.ts");
				} catch {
					/* Not found */
				}

				try {
					await access(outputPaths.client);
					found.push("api.client.ts");
				} catch {
					/* Not found */
				}
			} catch {
				// Config parsing failed
			}
		}

		return found;
	}

	/**
	 * Ensures openapi-typescript is installed as a dev dependency.
	 */
	private async ensureOpenApiTypescript(
		projectRoot: string,
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		logger.info("Checking for openapi-typescript...");

		// Check if already installed
		const packageJsonPath = path.join(projectRoot, "package.json");
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
		const deps = packageJson.dependencies || {};
		const devDeps = packageJson.devDependencies || {};

		if (deps["openapi-typescript"] || devDeps["openapi-typescript"]) {
			logger.info("openapi-typescript already installed");
			return;
		}

		// Install it
		logger.info("Installing openapi-typescript...");
		const result = spawnSync("pnpm", ["add", "-D", "openapi-typescript"], {
			cwd: projectRoot,
			stdio: "inherit",
		});

		if (result.status !== 0) {
			throw new Error("Failed to install openapi-typescript");
		}

		logger.info("openapi-typescript installed");
	}

	/**
	 * Runs pnpm install to link workspaces.
	 */
	private async runPnpmInstall(
		projectRoot: string,
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		logger.info("Running pnpm install...");

		const result = spawnSync("pnpm", ["install"], {
			cwd: projectRoot,
			stdio: "inherit",
		});

		if (result.status !== 0) {
			throw new Error("pnpm install failed");
		}

		logger.info("Dependencies installed");
	}

	/**
	 * Builds the CLI.
	 */
	private async buildCli(
		projectRoot: string,
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		logger.info("Building CLI...");

		const result = spawnSync("pnpm", ["--filter", "chowbea-axios", "build"], {
			cwd: projectRoot,
			stdio: "inherit",
		});

		if (result.status !== 0) {
			throw new Error("CLI build failed");
		}

		logger.info("CLI built successfully");
	}

	/**
	 * Runs initial fetch to download spec and generate types.
	 */
	private async runInitialFetch(
		projectRoot: string,
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		logger.info("Fetching OpenAPI spec and generating types...");

		const result = spawnSync(
			"node",
			["cli/chowbea-axios/bin/run.js", "fetch"],
			{
				cwd: projectRoot,
				stdio: "inherit",
			}
		);

		if (result.status !== 0) {
			logger.warn("Initial fetch failed - you can run 'pnpm api:fetch' later");
		} else {
			logger.info("Types generated successfully");
		}
	}

	/**
	 * Creates api.config.toml if it doesn't exist or if user confirms overwrite.
	 */
	private async setupConfig(
		projectRoot: string,
		flags: { force: boolean },
		instanceConfig: InstanceConfig,
		apiEndpoint: string,
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		const configPath = getConfigPath(projectRoot);
		const exists = await configExists(configPath);

		logger.info("Setting up api.config.toml...");

		if (exists) {
			if (flags.force) {
				logger.info("Overwriting existing config (--force)");
			} else {
				const shouldOverwrite = await confirm({
					message: "api.config.toml already exists. Overwrite?",
					default: false,
				});

				if (!shouldOverwrite) {
					logger.info("Skipping config creation");
					return;
				}
			}
		}

		// Generate config with instance settings and endpoint
		const configContent = this.generateConfigContent(
			instanceConfig,
			apiEndpoint
		);
		await writeFile(configPath, configContent, "utf8");
		logger.info({ path: configPath }, "Created api.config.toml");
	}

	/**
	 * Generates api.config.toml content with instance settings.
	 */
	private generateConfigContent(
		instanceConfig: InstanceConfig,
		apiEndpoint: string
	): string {
		return `# Chowbea Axios API Configuration
# Run 'chowbea-axios init' to regenerate with prompts

# Remote OpenAPI specification endpoint
api_endpoint = "${apiEndpoint}"

# Polling interval for watch mode (milliseconds)
poll_interval_ms = 10000

[output]
# Folder where all generated files are written
# Structure:
#   _internal/     - cache files (openapi.json, .api-cache.json)
#   _generated/    - generated code (api.types.ts, api.operations.ts)
#   api.instance.ts - axios instance (generated once, editable)
#   api.error.ts    - error handling (generated once, editable)
#   api.client.ts   - typed API facade (generated once, editable)
folder = "app/services/api"

[instance]
# Environment variable name for base URL
base_url_env = "${instanceConfig.base_url_env}"

# localStorage key for auth token
token_key = "${instanceConfig.token_key}"

# Include credentials (cookies) in requests
with_credentials = ${instanceConfig.with_credentials}

# Request timeout in milliseconds
timeout = ${instanceConfig.timeout}
`;
	}

	/**
	 * Creates or updates pnpm-workspace.yaml to include cli/*.
	 */
	private async setupWorkspace(
		projectRoot: string,
		flags: { force: boolean },
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		const workspacePath = path.join(projectRoot, "pnpm-workspace.yaml");

		logger.info("Setting up pnpm-workspace.yaml...");

		// Check if workspace file exists
		let existingContent: string | null = null;
		try {
			await access(workspacePath);
			existingContent = await readFile(workspacePath, "utf8");
		} catch {
			// File doesn't exist
		}

		// Check if cli/* is already included
		if (existingContent && existingContent.includes("cli/*")) {
			logger.info("pnpm-workspace.yaml already includes cli/*");
			return;
		}

		if (existingContent) {
			// File exists but doesn't have cli/*
			if (!flags.force) {
				const shouldModify = await confirm({
					message:
						"pnpm-workspace.yaml exists but doesn't include cli/*. Add it?",
					default: true,
				});

				if (!shouldModify) {
					logger.warn(
						"Skipping workspace setup - you may need to add cli/* manually"
					);
					return;
				}
			}

			// Append cli/* to existing packages
			const updatedContent = this.addCliToWorkspace(existingContent);
			await writeFile(workspacePath, updatedContent, "utf8");
			logger.info("Updated pnpm-workspace.yaml to include cli/*");
		} else {
			// Create new workspace file
			await writeFile(workspacePath, DEFAULT_WORKSPACE_YAML, "utf8");
			logger.info({ path: workspacePath }, "Created pnpm-workspace.yaml");
		}
	}

	/**
	 * Adds cli/* to an existing pnpm-workspace.yaml content.
	 * Handles various YAML formats including comments and different indentation.
	 */
	private addCliToWorkspace(content: string): string {
		const lines = content.split("\n");
		const result: string[] = [];
		let packagesLineIndex = -1;
		let firstPackageEntryIndex = -1;
		let detectedIndent = "  "; // Default indentation

		// First pass: find the packages section and first entry
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Find packages: line (ignoring comments)
			if (trimmed === "packages:" || trimmed.startsWith("packages:")) {
				packagesLineIndex = i;
			}

			// Find first package entry after packages: line
			if (
				packagesLineIndex !== -1 &&
				firstPackageEntryIndex === -1 &&
				trimmed.startsWith("-") &&
				!trimmed.startsWith("#")
			) {
				firstPackageEntryIndex = i;
				// Detect indentation from first entry
				const leadingSpaces = line.match(/^(\s*)/);
				if (leadingSpaces && leadingSpaces[1]) {
					detectedIndent = leadingSpaces[1];
				}
			}
		}

		// Build result with cli/* added in the right place
		for (let i = 0; i < lines.length; i++) {
			result.push(lines[i]);

			// Add cli/* after the first package entry
			if (i === firstPackageEntryIndex) {
				result.push(`${detectedIndent}- "cli/*"`);
			}
		}

		// If no packages section found, create one
		if (packagesLineIndex === -1) {
			result.push("");
			result.push("packages:");
			result.push('  - "cli/*"');
		} else if (firstPackageEntryIndex === -1) {
			// packages: exists but no entries - add cli/* right after it
			const insertIndex = result.findIndex(
				(line) =>
					line.trim() === "packages:" || line.trim().startsWith("packages:")
			);
			if (insertIndex !== -1) {
				result.splice(insertIndex + 1, 0, '  - "cli/*"');
			}
		}

		return result.join("\n");
	}

	/**
	 * Adds npm scripts to package.json.
	 */
	private async setupScripts(
		projectRoot: string,
		flags: { force: boolean },
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		const packageJsonPath = path.join(projectRoot, "package.json");

		logger.info("Setting up npm scripts...");

		// Read existing package.json
		let packageJson: Record<string, unknown>;
		try {
			const content = await readFile(packageJsonPath, "utf8");
			packageJson = JSON.parse(content);
		} catch (error) {
			logger.error("Could not read package.json");
			throw error;
		}

		// Ensure scripts object exists
		if (!packageJson.scripts || typeof packageJson.scripts !== "object") {
			packageJson.scripts = {};
		}

		const scripts = packageJson.scripts as Record<string, string>;

		// Find which scripts need to be added/updated
		const toAdd: string[] = [];
		const toUpdate: string[] = [];

		for (const [name, command] of Object.entries(DEFAULT_SCRIPTS)) {
			if (!(name in scripts)) {
				toAdd.push(name);
			} else if (scripts[name] !== command) {
				toUpdate.push(name);
			}
		}

		if (toAdd.length === 0 && toUpdate.length === 0) {
			logger.info("All npm scripts already configured");
			return;
		}

		// Report what will be done
		if (toAdd.length > 0) {
			logger.info({ scripts: toAdd }, "Scripts to add");
		}

		if (toUpdate.length > 0) {
			logger.info({ scripts: toUpdate }, "Scripts that differ from defaults");

			if (!flags.force) {
				const shouldUpdate = await confirm({
					message: `Update ${toUpdate.length} existing script(s) to chowbea-axios defaults?`,
					default: false,
				});

				if (!shouldUpdate) {
					// Only add new scripts, don't update existing
					toUpdate.length = 0;
				}
			}
		}

		// Apply changes
		for (const name of toAdd) {
			scripts[name] = DEFAULT_SCRIPTS[name];
		}

		for (const name of toUpdate) {
			scripts[name] = DEFAULT_SCRIPTS[name];
		}

		// Write updated package.json
		await writeFile(
			packageJsonPath,
			JSON.stringify(packageJson, null, 2) + "\n",
			"utf8"
		);

		logger.info(
			{ added: toAdd.length, updated: toUpdate.length },
			"Updated package.json scripts"
		);
	}

	/**
	 * Generates client files (api.instance.ts, api.error.ts, api.client.ts).
	 */
	private async setupClientFiles(
		projectRoot: string,
		instanceConfig: InstanceConfig,
		flags: { force: boolean },
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		logger.info("Setting up client files...");

		// Load config to get output paths
		const { config } = await loadConfig();
		const outputPaths = getOutputPaths(config, projectRoot);

		// Ensure output folders exist
		await ensureOutputFolders(outputPaths);

		// Generate client files
		const result = await generateClientFiles({
			paths: outputPaths,
			instanceConfig,
			logger,
			force: flags.force,
		});

		if (result.helpers || result.instance || result.error || result.client) {
			logger.info("Client files created:");
			if (result.helpers) logger.info(`  - ${outputPaths.helpers}`);
			if (result.instance) logger.info(`  - ${outputPaths.instance}`);
			if (result.error) logger.info(`  - ${outputPaths.error}`);
			if (result.client) logger.info(`  - ${outputPaths.client}`);
		} else {
			logger.info("Client files already exist (use --force to regenerate)");
		}
	}

	/**
	 * Detects the package manager based on lockfile presence.
	 * Returns 'pnpm', 'yarn', 'bun', or 'npm'.
	 */
	private async detectPackageManager(
		projectRoot: string
	): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
		// Check for lockfiles in order of preference
		try {
			await access(path.join(projectRoot, "pnpm-lock.yaml"));
			return "pnpm";
		} catch {
			/* Not found */
		}

		try {
			await access(path.join(projectRoot, "yarn.lock"));
			return "yarn";
		} catch {
			/* Not found */
		}

		try {
			await access(path.join(projectRoot, "bun.lockb"));
			return "bun";
		} catch {
			/* Not found */
		}

		try {
			await access(path.join(projectRoot, "package-lock.json"));
			return "npm";
		} catch {
			/* Not found */
		}

		// Default to pnpm if no lockfile found
		return "pnpm";
	}

	/**
	 * Sets up a concurrent watch script combining api:watch with user-selected dev scripts.
	 * Uses concurrently to run multiple scripts in parallel with labeled output.
	 */
	private async setupConcurrentlyScript(
		projectRoot: string,
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		// Ask if user wants concurrent dev mode
		const wantsConcurrent = await confirm({
			message:
				"Would you like to create a script that runs api:watch alongside your dev server?",
			default: true,
		});

		if (!wantsConcurrent) {
			logger.info("Skipping concurrent script setup");
			return;
		}

		// Prompt for script alias
		const scriptAlias = await input({
			message: "Enter a name for the concurrent script:",
			default: "dev:all",
			validate: (value) => {
				if (!value.trim()) return "Script name is required";
				if (!/^[a-z][a-z0-9:_-]*$/i.test(value)) return "Invalid script name";
				return true;
			},
		});

		// Read package.json to get existing scripts
		const packageJsonPath = path.join(projectRoot, "package.json");
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
		const scripts = (packageJson.scripts || {}) as Record<string, string>;

		// Filter out api:* scripts and the new alias itself
		const userScripts = Object.keys(scripts).filter(
			(name) => !name.startsWith("api:") && name !== scriptAlias
		);

		if (userScripts.length === 0) {
			logger.warn("No other scripts found to run concurrently");
			return;
		}

		// Let user select which scripts to include
		const selectedScripts = await checkbox({
			message: "Select scripts to run alongside api:watch:",
			choices: userScripts.map((name) => ({
				name: `${name}: ${scripts[name].slice(0, 50)}${scripts[name].length > 50 ? "..." : ""}`,
				value: name,
			})),
		});

		if (selectedScripts.length === 0) {
			logger.info("No scripts selected, skipping concurrent setup");
			return;
		}

		// Collect short labels for each selected script
		const labels: Record<string, string> = { "api:watch": "api" };

		for (const scriptName of selectedScripts) {
			const defaultLabel = scriptName
				.replace(/[^a-z0-9]/gi, "")
				.slice(0, 6)
				.toLowerCase();
			const label = await input({
				message: `Short label for "${scriptName}" (shown in terminal output):`,
				default: defaultLabel || "cmd",
				validate: (value) => value.trim().length > 0 || "Label is required",
			});
			labels[scriptName] = label.trim();
		}

		// Detect package manager for the run command
		const pm = await this.detectPackageManager(projectRoot);
		const runCmd = pm === "npm" ? "npm run" : pm;

		// Build the concurrently command
		const allScripts = ["api:watch", ...selectedScripts];
		const names = allScripts.map((s) => labels[s]).join(",");
		const commands = allScripts.map((s) => `"${runCmd} ${s}"`).join(" ");
		const concurrentlyCmd = `concurrently --names '${names}' ${commands}`;

		// Add the script to package.json
		scripts[scriptAlias] = concurrentlyCmd;
		packageJson.scripts = scripts;

		await writeFile(
			packageJsonPath,
			JSON.stringify(packageJson, null, 2) + "\n",
			"utf8"
		);
		logger.info({ script: scriptAlias, pm }, "Created concurrent script");

		// Ensure concurrently is installed
		await this.ensureConcurrently(projectRoot, pm, logger);
	}

	/**
	 * Ensures concurrently is installed as a dev dependency.
	 */
	private async ensureConcurrently(
		projectRoot: string,
		pm: "pnpm" | "yarn" | "bun" | "npm",
		logger: ReturnType<typeof createLogger>
	): Promise<void> {
		const packageJsonPath = path.join(projectRoot, "package.json");
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
		const devDeps = packageJson.devDependencies || {};

		if (devDeps.concurrently) {
			logger.debug("concurrently already installed");
			return;
		}

		logger.info("Installing concurrently...");

		// Build install command based on package manager
		let cmd: string;
		let args: string[];
		switch (pm) {
			case "yarn":
				cmd = "yarn";
				args = ["add", "-D", "concurrently"];
				break;
			case "bun":
				cmd = "bun";
				args = ["add", "-d", "concurrently"];
				break;
			case "npm":
				cmd = "npm";
				args = ["install", "-D", "concurrently"];
				break;
			default:
				cmd = "pnpm";
				args = ["add", "-D", "concurrently"];
		}

		const result = spawnSync(cmd, args, {
			cwd: projectRoot,
			stdio: "inherit",
		});

		if (result.status !== 0) {
			logger.warn(
				"Failed to install concurrently - you may need to install it manually"
			);
		} else {
			logger.info("concurrently installed");
		}
	}
}
