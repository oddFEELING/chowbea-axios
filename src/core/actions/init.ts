/**
 * Init action — pure business logic extracted from the init command.
 *
 * All interactive prompts go through the PromptProvider interface so that
 * the TUI can supply OpenTUI form components while headless mode uses
 * @inquirer/prompts.
 */

import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type AuthMode,
  configExists,
  DEFAULT_CONFIG,
  DEFAULT_INSTANCE_CONFIG,
  ensureOutputFolders,
  findProjectRoot,
  generateConfigTemplate,
  getConfigPath,
  getOutputPaths,
  type InstanceConfig,
  loadConfig,
} from "../config.js";
import { generateClientFiles } from "../generator.js";
import {
  detectPackageManager,
  getDlxCommand,
  getInstallCommand,
  getRunCommand,
  type PackageManager,
} from "../pm.js";

import type { Logger } from "../../adapters/logger-interface.js";
import type { ClientFilesResult } from "./types.js";

// ---------------------------------------------------------------------------
// PromptProvider interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over interactive prompts.
 * Implementations:
 *  - Headless: thin wrapper around @inquirer/prompts
 *  - TUI: OpenTUI form components that render in the terminal UI
 */
export interface PromptProvider {
  input(opts: {
    message: string;
    default?: string;
    validate?: (value: string) => string | true;
  }): Promise<string>;

  select<T>(opts: {
    message: string;
    choices: Array<{ name: string; value: T }>;
    default?: T;
  }): Promise<T>;

  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;

  checkbox<T>(opts: {
    message: string;
    choices: Array<{ name: string; value: T }>;
  }): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Option / result interfaces
// ---------------------------------------------------------------------------

/** Options accepted by executeInit (mapped from CLI flags). */
export interface InitActionOptions {
  force: boolean;
  skipScripts: boolean;
  skipClient: boolean;
  skipConcurrent: boolean;
  baseUrlEnv: string;
  envAccessor: string;
  tokenKey: string;
  authMode: AuthMode;
  withCredentials: boolean;
  timeout: number;
}

/** Structured result returned after a successful init. */
export interface InitResult {
  configCreated: boolean;
  scriptsAdded: string[];
  scriptsUpdated: string[];
  clientFilesCreated: ClientFilesResult;
  axiosInstalled: boolean;
  concurrentlyInstalled: boolean;
  concurrentScript: string | null;
  initialFetchSuccess: boolean | null;
}

// ---------------------------------------------------------------------------
// Default npm scripts to add to package.json
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
// Standalone helper functions (were private methods on the Command class)
// ---------------------------------------------------------------------------

/**
 * Detects existing setup files to notify user.
 * Does NOT auto-create any files — only checks what exists.
 */
export async function detectExistingSetup(
  projectRoot: string,
): Promise<string[]> {
  const found: string[] = [];

  const configPath = getConfigPath(projectRoot);
  const hasConfig = await configExists(configPath);
  if (hasConfig) {
    found.push("api.config.toml");
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
      // Config parsing failed — ignore
    }
  }

  return found;
}

/**
 * Checks if any of the given filenames exist in the project root.
 */
export async function hasFile(
  projectRoot: string,
  filenames: string[],
): Promise<boolean> {
  for (const filename of filenames) {
    try {
      await access(path.join(projectRoot, filename));
      return true;
    } catch {
      /* Not found */
    }
  }
  return false;
}

/**
 * Creates api.config.toml if it doesn't exist or if user confirms overwrite.
 * Returns true when the file was (over)written.
 */
async function setupConfig(
  projectRoot: string,
  force: boolean,
  instanceConfig: InstanceConfig,
  apiEndpoint: string,
  outputFolder: string,
  logger: Logger,
  prompts: PromptProvider,
): Promise<boolean> {
  const configPath = getConfigPath(projectRoot);
  const exists = await configExists(configPath);

  logger.step("config", "Creating api.config.toml...");

  if (exists) {
    if (force) {
      logger.info("Overwriting existing config (--force)");
    } else {
      const shouldOverwrite = await prompts.confirm({
        message: "api.config.toml already exists. Overwrite?",
        default: false,
      });

      if (!shouldOverwrite) {
        logger.info("Skipping config creation");
        return false;
      }
    }
  }

  const configContent = generateConfigTemplate({
    api_endpoint: apiEndpoint,
    poll_interval_ms: 10_000,
    output: { folder: outputFolder },
    instance: instanceConfig,
    watch: { debug: false },
  });
  await writeFile(configPath, configContent, "utf8");
  logger.info({ path: configPath }, "Created api.config.toml");
  return true;
}

/**
 * Ensures axios is installed as a dependency.
 * Returns true when it was freshly installed.
 */
async function ensureAxios(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const deps = (packageJson.dependencies ?? {}) as Record<string, string>;

  if (deps.axios) {
    logger.info("axios already installed");
    return false;
  }

  logger.step("deps", "Installing axios...");

  const [cmd, ...args] = getInstallCommand(pm, "axios");
  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    logger.warn("Failed to install axios - please install it manually");
    return false;
  }

  logger.info("axios installed");
  return true;
}

/**
 * Adds npm scripts to package.json.
 * Returns arrays of added and updated script names.
 */
async function setupScripts(
  projectRoot: string,
  force: boolean,
  logger: Logger,
  prompts: PromptProvider,
): Promise<{ added: string[]; updated: string[] }> {
  const packageJsonPath = path.join(projectRoot, "package.json");

  logger.step("scripts", "Setting up npm scripts...");

  let packageJson: Record<string, unknown>;
  try {
    const content = await readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(content);
  } catch (error) {
    logger.error("Could not read package.json");
    throw error;
  }

  if (!packageJson.scripts || typeof packageJson.scripts !== "object") {
    packageJson.scripts = {};
  }

  const scripts = packageJson.scripts as Record<string, string>;

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
    return { added: [], updated: [] };
  }

  if (toAdd.length > 0) {
    logger.info({ scripts: toAdd }, "Scripts to add");
  }

  if (toUpdate.length > 0) {
    logger.info({ scripts: toUpdate }, "Scripts that differ from defaults");

    if (!force) {
      const shouldUpdate = await prompts.confirm({
        message: `Update ${toUpdate.length} existing script(s) to chowbea-axios defaults?`,
        default: false,
      });

      if (!shouldUpdate) {
        // Only add new scripts, don't update existing
        toUpdate.length = 0;
      }
    }
  }

  for (const name of toAdd) {
    scripts[name] = DEFAULT_SCRIPTS[name];
  }

  for (const name of toUpdate) {
    scripts[name] = DEFAULT_SCRIPTS[name];
  }

  await writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf8",
  );

  logger.info(
    { added: toAdd.length, updated: toUpdate.length },
    "Updated package.json scripts",
  );

  return { added: toAdd, updated: toUpdate };
}

/**
 * Generates client files (api.instance.ts, api.error.ts, api.client.ts).
 */
async function setupClientFiles(
  projectRoot: string,
  instanceConfig: InstanceConfig,
  force: boolean,
  logger: Logger,
): Promise<ClientFilesResult> {
  logger.step("client", "Generating client files...");

  const { config } = await loadConfig();
  const outputPaths = getOutputPaths(config, projectRoot);

  await ensureOutputFolders(outputPaths);

  const result = await generateClientFiles({
    paths: outputPaths,
    instanceConfig,
    logger,
    force,
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

  return result;
}

/**
 * Ensures concurrently is installed as a dev dependency.
 * Returns true when it was freshly installed.
 */
async function ensureConcurrently(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const devDeps = (packageJson.devDependencies ?? {}) as Record<string, string>;

  if (devDeps.concurrently) {
    logger.debug("concurrently already installed");
    return false;
  }

  logger.step("deps", "Installing concurrently...");

  const [cmd, ...args] = getInstallCommand(pm, "concurrently", true);
  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    logger.warn(
      "Failed to install concurrently - you may need to install it manually",
    );
    return false;
  }

  logger.info("concurrently installed");
  return true;
}

/**
 * Sets up a concurrent watch script combining api:watch with user-selected
 * dev scripts.  Uses concurrently to run multiple scripts in parallel.
 *
 * Returns the script alias that was created, or null if skipped.
 */
async function setupConcurrentlyScript(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
  prompts: PromptProvider,
): Promise<{ scriptAlias: string | null; installed: boolean }> {
  const wantsConcurrent = await prompts.confirm({
    message:
      "Would you like to create a script that runs api:watch alongside your dev server?",
    default: true,
  });

  if (!wantsConcurrent) {
    logger.info("Skipped concurrent script setup");
    return { scriptAlias: null, installed: false };
  }

  const scriptAlias = await prompts.input({
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
  const scripts = ((packageJson.scripts ?? {}) as Record<string, string>);

  // Filter out api:* scripts and the new alias itself
  const userScripts = Object.keys(scripts).filter(
    (name) => !name.startsWith("api:") && name !== scriptAlias,
  );

  if (userScripts.length === 0) {
    logger.warn("No other scripts found to run concurrently");
    return { scriptAlias: null, installed: false };
  }

  // Let user select which scripts to include
  const selectedScripts = await prompts.checkbox<string>({
    message: "Select scripts to run alongside api:watch:",
    choices: userScripts.map((name) => ({
      name: `${name}: ${scripts[name].slice(0, 50)}${
        scripts[name].length > 50 ? "..." : ""
      }`,
      value: name,
    })),
  });

  if (selectedScripts.length === 0) {
    logger.info("No scripts selected, skipping concurrent setup");
    return { scriptAlias: null, installed: false };
  }

  // Collect short labels for each selected script
  const labels: Record<string, string> = { "api:watch": "api" };

  for (const scriptName of selectedScripts) {
    const defaultLabel = scriptName
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 6)
      .toLowerCase();
    const label = await prompts.input({
      message: `Short label for "${scriptName}" (shown in terminal output):`,
      default: defaultLabel || "cmd",
      validate: (value) => (value.trim().length > 0 ? true : "Label is required"),
    });
    labels[scriptName] = label.trim();
  }

  const runCmd = getRunCommand(pm);

  // Build the concurrently command
  const allScripts = ["api:watch", ...selectedScripts];
  const names = allScripts.map((s) => labels[s]).join(",");
  const commands = allScripts.map((s) => `"${runCmd} ${s}"`).join(" ");
  const concurrentlyCmd = `concurrently --names '${names}' ${commands}`;

  // Write updated package.json
  scripts[scriptAlias] = concurrentlyCmd;
  packageJson.scripts = scripts;

  await writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf8",
  );
  logger.info({ script: scriptAlias, pm }, "Created concurrent script");

  // Ensure concurrently is installed
  const installed = await ensureConcurrently(projectRoot, pm, logger);

  return { scriptAlias, installed };
}

/**
 * Runs initial fetch to download spec and generate types.
 * Returns true on success, false on failure.
 */
async function runInitialFetch(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
): Promise<boolean> {
  logger.step("fetch", "Fetching OpenAPI spec and generating types...");

  const [cmd, ...dlxArgs] = getDlxCommand(pm);
  const result = spawnSync(cmd, [...dlxArgs, "chowbea-axios", "fetch"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  const runCmd = getRunCommand(pm);
  if (result.status !== 0) {
    logger.warn(
      `Initial fetch failed - you can run '${runCmd} api:fetch' later`,
    );
    return false;
  }

  logger.info("Types generated successfully");
  return true;
}

// ---------------------------------------------------------------------------
// Main action entry point
// ---------------------------------------------------------------------------

/**
 * Execute the init workflow.
 *
 * Pure function — all side-effects (prompts, logging, fs, child_process)
 * are injected via parameters so that the action can be driven by any UI.
 */
export async function executeInit(
  options: InitActionOptions,
  logger: Logger,
  prompts: PromptProvider,
): Promise<InitResult> {
  logger.header("chowbea-axios init");

  // Find project root
  logger.step("config", "Finding project root...");
  const projectRoot = await findProjectRoot();
  logger.info(projectRoot);

  // Check for existing setup and notify user
  const existingSetup = await detectExistingSetup(projectRoot);
  if (existingSetup.length > 0 && !options.force) {
    logger.step("detect", "Existing setup detected");
    for (const item of existingSetup) {
      logger.info(item);
    }
    const shouldContinue = await prompts.confirm({
      message: "Continue with setup? (existing files may be modified)",
      default: true,
    });
    if (!shouldContinue) {
      logger.info("Setup cancelled");
      return {
        configCreated: false,
        scriptsAdded: [],
        scriptsUpdated: [],
        clientFilesCreated: {
          helpers: false,
          instance: false,
          error: false,
          client: false,
        },
        axiosInstalled: false,
        concurrentlyInstalled: false,
        concurrentScript: null,
        initialFetchSuccess: null,
      };
    }
  }

  // Prompt for API endpoint URL
  const apiEndpoint = await prompts.input({
    message: "Enter your OpenAPI spec endpoint URL:",
    default: DEFAULT_CONFIG.api_endpoint,
  });

  // Prompt for output folder location
  const outputFolder = await prompts.input({
    message: "Where should generated API files be placed?",
    default: DEFAULT_CONFIG.output.folder,
    validate: (value) =>
      value.trim().length > 0 ? true : "Output folder is required",
  });

  // Detect package manager and confirm with user
  const detectedPm = await detectPackageManager(projectRoot);
  const pm: PackageManager = await prompts.select<PackageManager>({
    message: "Which package manager are you using?",
    choices: [
      { name: "pnpm", value: "pnpm" },
      { name: "npm", value: "npm" },
      { name: "yarn", value: "yarn" },
      { name: "bun", value: "bun" },
    ],
    default: detectedPm,
  });

  // Auto-detect env accessor from framework config files
  let envAccessor = options.envAccessor;
  if (envAccessor === DEFAULT_INSTANCE_CONFIG.env_accessor) {
    const hasViteConfig = await hasFile(projectRoot, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
    ]);
    if (hasViteConfig) {
      envAccessor = "import.meta.env";
      logger.info("Detected Vite project — using import.meta.env");
    }
  }

  // Prompt for auth mode
  const authMode: AuthMode = await prompts.select<AuthMode>({
    message: "How should auth tokens be attached to requests?",
    choices: [
      {
        name: "Bearer token from localStorage (SPA pattern)",
        value: "bearer-localstorage",
      },
      {
        name: "Custom — I'll implement my own auth logic",
        value: "custom",
      },
      {
        name: "None — no auth interceptor needed",
        value: "none",
      },
    ],
    default: options.authMode,
  });

  // Build instance config from options and prompts
  const instanceConfig: InstanceConfig = {
    base_url_env: options.baseUrlEnv,
    env_accessor: envAccessor,
    token_key: options.tokenKey,
    auth_mode: authMode,
    with_credentials: options.withCredentials,
    timeout: options.timeout,
  };

  // Step 1: Create api.config.toml
  const configCreated = await setupConfig(
    projectRoot,
    options.force,
    instanceConfig,
    apiEndpoint,
    outputFolder,
    logger,
    prompts,
  );

  // Step 2: Install axios dependency
  const axiosInstalled = await ensureAxios(projectRoot, pm, logger);

  // Step 3: Add npm scripts to package.json
  let scriptsAdded: string[] = [];
  let scriptsUpdated: string[] = [];
  if (!options.skipScripts) {
    const scriptResult = await setupScripts(
      projectRoot,
      options.force,
      logger,
      prompts,
    );
    scriptsAdded = scriptResult.added;
    scriptsUpdated = scriptResult.updated;
  }

  // Step 4: Setup concurrent dev script (optional)
  let concurrentScript: string | null = null;
  let concurrentlyInstalled = false;
  if (!options.skipConcurrent) {
    const concurrentResult = await setupConcurrentlyScript(
      projectRoot,
      pm,
      logger,
      prompts,
    );
    concurrentScript = concurrentResult.scriptAlias;
    concurrentlyInstalled = concurrentResult.installed;
  }

  // Step 5: Generate client files
  let clientFilesCreated: ClientFilesResult = {
    helpers: false,
    instance: false,
    error: false,
    client: false,
  };
  if (!options.skipClient) {
    clientFilesCreated = await setupClientFiles(
      projectRoot,
      instanceConfig,
      options.force,
      logger,
    );
  }

  // Step 6: Run initial fetch (if not localhost default)
  const isLocalhost =
    apiEndpoint.includes("localhost") || apiEndpoint.includes("127.0.0.1");
  let initialFetchSuccess: boolean | null = null;
  if (!isLocalhost) {
    initialFetchSuccess = await runInitialFetch(projectRoot, pm, logger);
  }

  // Summary
  const runCmd = getRunCommand(pm);
  if (isLocalhost) {
    logger.done("Setup complete! When your API server is running:");
    logger.info(`${runCmd} api:fetch    # Fetch spec and generate types`);
  } else {
    logger.done("Setup complete!");
    logger.info(`${runCmd} api:status   # Check current status`);
    logger.info(`${runCmd} api:fetch    # Re-fetch spec and regenerate`);
    logger.info(`${runCmd} api:watch    # Watch for spec changes`);
  }

  return {
    configCreated,
    scriptsAdded,
    scriptsUpdated,
    clientFilesCreated,
    axiosInstalled,
    concurrentlyInstalled,
    concurrentScript,
    initialFetchSuccess,
  };
}
