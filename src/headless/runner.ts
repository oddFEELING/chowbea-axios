/**
 * Headless command runner -- replaces oclif's command dispatch for CI/scripting.
 *
 * Parses CLI arguments using node:util parseArgs, routes to the appropriate
 * core action, and renders output with the headless logger + formatters.
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { createLogger } from "../adapters/headless-logger.js";
import { getLogLevel } from "../adapters/logger-interface.js";
import { formatError } from "../core/errors.js";
import { formatStatusOutput, formatDiffSummary } from "./formatters.js";

// ---- Core actions ----------------------------------------------------------
import { executeFetch } from "../core/actions/fetch.js";
import type { FetchActionOptions } from "../core/actions/fetch.js";
import { executeGenerate } from "../core/actions/generate.js";
import type { GenerateActionOptions } from "../core/actions/generate.js";
import { executeStatus } from "../core/actions/status.js";
import { executeDiff } from "../core/actions/diff.js";
import { executeValidate } from "../core/actions/validate.js";
import { executeWatch } from "../core/actions/watch.js";
import {
	executeInit,
	type PromptProvider,
	type InitActionOptions,
} from "../core/actions/init.js";
import type { AuthMode } from "../core/config.js";
import { DEFAULT_INSTANCE_CONFIG } from "../core/config.js";

// ---- Known commands --------------------------------------------------------
const COMMANDS = [
	"fetch",
	"generate",
	"status",
	"diff",
	"validate",
	"watch",
	"init",
] as const;

type CommandName = (typeof COMMANDS)[number];

// ---- Help text -------------------------------------------------------------

function printHelp(): void {
	console.log(`
  ${"\x1b[1m"}chowbea-axios${"\x1b[0m"} - Type-safe axios client generator

  ${"\x1b[1m"}USAGE${"\x1b[0m"}
    chowbea-axios <command> [flags]

  ${"\x1b[1m"}COMMANDS${"\x1b[0m"}
    fetch        Fetch OpenAPI spec and generate types/operations
    generate     Generate types/operations from cached spec
    status       Show current status of config, cache, and generated files
    diff         Compare current vs new spec and show changes
    validate     Validate the OpenAPI spec
    watch        Watch for spec changes and auto-regenerate
    init         Initialize chowbea-axios in your project

  ${"\x1b[1m"}GLOBAL FLAGS${"\x1b[0m"}
    -q, --quiet      Suppress non-error output
    -v, --verbose    Show detailed output
    -h, --help       Show help
        --version    Show version
        --headless   Force headless mode (auto-detected in non-TTY)

  Run 'chowbea-axios <command> --help' for command-specific flags.
`);
}

function printCommandHelp(command: CommandName): void {
	const helps: Record<CommandName, string> = {
		fetch: `
  ${"\x1b[1m"}chowbea-axios fetch${"\x1b[0m"} - Fetch OpenAPI spec and generate types/operations

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
    -e, --endpoint <url>   Override API endpoint URL
    -s, --spec-file <path> Use local spec file instead of fetching
    -f, --force            Force regeneration even if spec hasn't changed
    -n, --dry-run          Show what would be generated without writing
        --types-only       Generate only TypeScript types
        --operations-only  Generate only operations
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		generate: `
  ${"\x1b[1m"}chowbea-axios generate${"\x1b[0m"} - Generate types/operations from cached spec

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
    -s, --spec-file <path> Use local spec file
    -n, --dry-run          Show what would be generated without writing
        --types-only       Generate only TypeScript types
        --operations-only  Generate only operations
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		status: `
  ${"\x1b[1m"}chowbea-axios status${"\x1b[0m"} - Show current status

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>  Path to api.config.toml
    -q, --quiet          Suppress non-error output
    -v, --verbose        Show detailed output
`,
		diff: `
  ${"\x1b[1m"}chowbea-axios diff${"\x1b[0m"} - Compare current vs new spec

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>  Path to api.config.toml
    -s, --spec <path>    Path to new spec file to compare against
    -q, --quiet          Suppress non-error output
    -v, --verbose        Show detailed output
`,
		validate: `
  ${"\x1b[1m"}chowbea-axios validate${"\x1b[0m"} - Validate the OpenAPI spec

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>  Path to api.config.toml
    -s, --spec <path>    Path to spec file to validate
        --strict         Treat warnings as errors
    -q, --quiet          Suppress non-error output
    -v, --verbose        Show detailed output
`,
		watch: `
  ${"\x1b[1m"}chowbea-axios watch${"\x1b[0m"} - Watch for spec changes

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>     Path to api.config.toml
    -i, --interval <ms>     Polling interval in milliseconds
    -q, --quiet             Suppress non-error output
    -d, --debug             Enable debug logging
`,
		init: `
  ${"\x1b[1m"}chowbea-axios init${"\x1b[0m"} - Initialize chowbea-axios in your project

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -f, --force              Overwrite existing files
        --skip-scripts       Skip adding npm scripts
        --skip-client        Skip generating client files
        --skip-concurrent    Skip concurrent script setup
        --base-url-env <var> Environment variable for base URL
        --env-accessor <str> How to access env vars (e.g. "process.env")
        --token-key <key>    localStorage key for auth token
        --auth-mode <mode>   Auth mode: bearer-localstorage | custom | none
        --with-credentials   Include credentials in requests
        --timeout <ms>       Request timeout in milliseconds
    -q, --quiet              Suppress non-error output
    -v, --verbose            Show detailed output
`,
	};

	console.log(helps[command]);
}

// ---- Inquirer-based PromptProvider for headless init -----------------------

function createHeadlessPromptProvider(): PromptProvider {
	return {
		async input(opts) {
			const { input } = await import("@inquirer/prompts");
			return input(opts);
		},
		async select(opts) {
			const { select } = await import("@inquirer/prompts");
			return select(opts);
		},
		async confirm(opts) {
			const { confirm } = await import("@inquirer/prompts");
			return confirm(opts);
		},
		async checkbox(opts) {
			const { checkbox } = await import("@inquirer/prompts");
			return checkbox(opts);
		},
	};
}

// ---- Command handlers ------------------------------------------------------

async function handleFetch(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			endpoint: { type: "string", short: "e" },
			"spec-file": { type: "string", short: "s" },
			force: { type: "boolean", short: "f", default: false },
			"dry-run": { type: "boolean", short: "n", default: false },
			"types-only": { type: "boolean", default: false },
			"operations-only": { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: FetchActionOptions = {
		configPath: values.config,
		endpoint: values.endpoint,
		specFile: values["spec-file"],
		force: values.force ?? false,
		dryRun: values["dry-run"] ?? false,
		typesOnly: values["types-only"] ?? false,
		operationsOnly: values["operations-only"] ?? false,
	};

	try {
		const result = await executeFetch(options, logger);
		if (!result.specChanged && !values.quiet) {
			logger.info("Spec unchanged, nothing to do. Use --force to regenerate.");
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleGenerate(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			"spec-file": { type: "string", short: "s" },
			"dry-run": { type: "boolean", short: "n", default: false },
			"types-only": { type: "boolean", default: false },
			"operations-only": { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: GenerateActionOptions = {
		configPath: values.config,
		specFile: values["spec-file"],
		dryRun: values["dry-run"] ?? false,
		typesOnly: values["types-only"] ?? false,
		operationsOnly: values["operations-only"] ?? false,
	};

	try {
		await executeGenerate(options, logger);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleStatus(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	try {
		const result = await executeStatus({ configPath: values.config }, logger);
		console.log(formatStatusOutput(result));
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleDiff(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			spec: { type: "string", short: "s" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	try {
		const result = await executeDiff(
			{ configPath: values.config, specFile: values.spec },
			logger,
		);
		console.log(formatDiffSummary(result));
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleValidate(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			spec: { type: "string", short: "s" },
			strict: { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	try {
		const result = await executeValidate(
			{
				configPath: values.config,
				specFile: values.spec,
				strict: values.strict,
			},
			logger,
		);

		// Display results
		if (result.valid) {
			logger.done("Spec is valid");
		} else {
			logger.step("validate", "Validation issues found");
		}

		for (const issue of result.errors) {
			logger.error(`[${issue.path}] ${issue.message}`);
		}

		for (const issue of result.warnings) {
			logger.warn(`[${issue.path}] ${issue.message}`);
		}

		if (!result.valid) {
			process.exitCode = 1;
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleWatch(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			interval: { type: "string", short: "i" },
			quiet: { type: "boolean", short: "q", default: false },
			debug: { type: "boolean", short: "d", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		debug: values.debug,
	});
	const logger = createLogger({ level });

	const intervalMs = values.interval ? parseInt(values.interval, 10) : undefined;

	if (intervalMs !== undefined && (isNaN(intervalMs) || intervalMs <= 0)) {
		console.error(`Invalid interval value: "${values.interval}". Must be a positive number of milliseconds.`);
		process.exitCode = 1;
		return;
	}

	// Setup SIGINT handler for graceful shutdown
	const controller = new AbortController();
	const onSigint = () => {
		controller.abort();
	};
	process.on("SIGINT", onSigint);

	try {
		await executeWatch(
			{
				configPath: values.config,
				intervalMs,
				debug: values.debug,
				signal: controller.signal,
			},
			logger,
		);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

async function handleInit(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			force: { type: "boolean", short: "f", default: false },
			"skip-scripts": { type: "boolean", default: false },
			"skip-client": { type: "boolean", default: false },
			"skip-concurrent": { type: "boolean", default: false },
			"base-url-env": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.base_url_env,
			},
			"env-accessor": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.env_accessor,
			},
			"token-key": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.token_key,
			},
			"auth-mode": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.auth_mode,
			},
			"with-credentials": {
				type: "boolean",
				default: DEFAULT_INSTANCE_CONFIG.with_credentials,
			},
			timeout: {
				type: "string",
				default: String(DEFAULT_INSTANCE_CONFIG.timeout),
			},
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const VALID_AUTH_MODES: readonly string[] = ["bearer-localstorage", "custom", "none"];
	const rawAuthMode = values["auth-mode"] ?? DEFAULT_INSTANCE_CONFIG.auth_mode;
	if (!VALID_AUTH_MODES.includes(rawAuthMode)) {
		console.error(`Invalid auth-mode: "${rawAuthMode}". Must be one of: ${VALID_AUTH_MODES.join(", ")}`);
		process.exitCode = 1;
		return;
	}

	const options: InitActionOptions = {
		force: values.force ?? false,
		skipScripts: values["skip-scripts"] ?? false,
		skipClient: values["skip-client"] ?? false,
		skipConcurrent: values["skip-concurrent"] ?? false,
		baseUrlEnv: values["base-url-env"] ?? DEFAULT_INSTANCE_CONFIG.base_url_env,
		envAccessor:
			values["env-accessor"] ?? DEFAULT_INSTANCE_CONFIG.env_accessor,
		tokenKey: values["token-key"] ?? DEFAULT_INSTANCE_CONFIG.token_key,
		authMode: rawAuthMode as AuthMode,
		withCredentials: values["with-credentials"] ?? DEFAULT_INSTANCE_CONFIG.with_credentials,
		timeout: parseInt(values.timeout ?? String(DEFAULT_INSTANCE_CONFIG.timeout), 10),
	};

	const prompts = createHeadlessPromptProvider();

	try {
		await executeInit(options, logger, prompts);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

// ---- Main entry point ------------------------------------------------------

/**
 * Headless command runner.
 * Parses the command name and flags, routes to the appropriate action.
 *
 * @param command - The command name (first positional arg), may be undefined
 * @param args    - All args (including the command name as the first element)
 */
export async function runHeadless(
	command: string | undefined,
	args: string[],
): Promise<void> {
	// Pre-cache openapi-typescript for fetch/generate commands
	if (command === "fetch" || command === "generate") {
		const { findProjectRoot } = await import("../core/config.js");
		const { detectPackageManager, getDlxCommand } = await import(
			"../core/pm.js"
		);
		try {
			const projectRoot = await findProjectRoot();
			const pm = await detectPackageManager(projectRoot);
			const [dlxCmd, ...dlxArgs] = getDlxCommand(pm);
			const check = spawnSync(
				dlxCmd,
				[...dlxArgs, "openapi-typescript", "--version"],
				{
					cwd: projectRoot,
					stdio: "pipe",
					timeout: 30_000,
				},
			);
			if (check.status !== 0) {
				// Force download by running --help
				spawnSync(
					dlxCmd,
					[...dlxArgs, "openapi-typescript", "--help"],
					{
						cwd: projectRoot,
						stdio: "pipe",
						timeout: 60_000,
					},
				);
			}
		} catch {
			/* non-fatal */
		}
	}

	// Strip the command name and global-only flags from args for sub-parsers
	const commandArgs = args.filter((a) => a !== command && a !== "--headless");

	// --version
	if (args.includes("--version")) {
		try {
			const { readFileSync } = await import("node:fs");
			const { resolve, dirname } = await import("node:path");
			const { fileURLToPath } = await import("node:url");
			const thisDir = dirname(fileURLToPath(import.meta.url));
			const pkgPath = resolve(thisDir, "..", "..", "package.json");
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
			console.log(`chowbea-axios v${pkg.version}`);
		} catch {
			console.log("chowbea-axios (unknown version)");
		}
		return;
	}

	// Check for global --help before routing
	if (!command || args.includes("--help") || args.includes("-h")) {
		if (command && COMMANDS.includes(command as CommandName)) {
			printCommandHelp(command as CommandName);
		} else {
			printHelp();
		}
		return;
	}

	// Route to command handler
	switch (command) {
		case "fetch":
			await handleFetch(commandArgs);
			break;
		case "generate":
			await handleGenerate(commandArgs);
			break;
		case "status":
			await handleStatus(commandArgs);
			break;
		case "diff":
			await handleDiff(commandArgs);
			break;
		case "validate":
			await handleValidate(commandArgs);
			break;
		case "watch":
			await handleWatch(commandArgs);
			break;
		case "init":
			await handleInit(commandArgs);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exitCode = 1;
			break;
	}
}
