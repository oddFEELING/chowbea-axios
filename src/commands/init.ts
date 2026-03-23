/**
 * Init command - full project setup for chowbea-axios.
 * Creates config, adds workspace entry, adds npm scripts, generates client files,
 * installs dependencies, builds CLI, and runs initial fetch.
 */

import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command, Flags } from "@oclif/core";

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
} from "../lib/config.js";
import { formatError } from "../lib/errors.js";
import { generateClientFiles } from "../lib/generator.js";
import { createLogger, getLogLevel } from "../lib/logger.js";
import {
  detectPackageManager,
  getDlxCommand,
  getInstallCommand,
  getRunCommand,
  type PackageManager,
} from "../lib/pm.js";

/**
 * Default npm scripts to add to package.json.
 * Uses npx to run the CLI commands.
 */
const DEFAULT_SCRIPTS: Record<string, string> = {
  "api:generate": "chowbea-axios generate",
  "api:fetch": "chowbea-axios fetch",
  "api:watch": "chowbea-axios watch",
  "api:status": "chowbea-axios status",
  "api:validate": "chowbea-axios validate",
  "api:diff": "chowbea-axios diff",
};

/**
 * Initialize chowbea-axios in a project.
 * Creates config and npm scripts.
 */
export default class Init extends Command {
  static override description = `Full project setup - one command to get started.

Prompts for your API endpoint, then automatically:
- Creates api.config.toml with your settings
- Adds npm scripts (api:fetch, api:generate, etc.)
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
    "env-accessor": Flags.string({
      description: 'How to access env vars (e.g., "process.env" or "import.meta.env")',
      default: DEFAULT_INSTANCE_CONFIG.env_accessor,
    }),
    "token-key": Flags.string({
      description: "localStorage key for auth token",
      default: DEFAULT_INSTANCE_CONFIG.token_key,
    }),
    "auth-mode": Flags.string({
      description: "Auth interceptor mode: bearer-localstorage, custom, or none",
      default: DEFAULT_INSTANCE_CONFIG.auth_mode,
      options: ["bearer-localstorage", "custom", "none"],
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

    logger.header("chowbea-axios init");

    try {
      // Find project root
      logger.step("config", "Finding project root...");
      const projectRoot = await findProjectRoot();
      logger.info(projectRoot);

      // Check for existing setup and notify user
      const existingSetup = await this.detectExistingSetup(projectRoot);
      if (existingSetup.length > 0 && !flags.force) {
        logger.step("detect", "Existing setup detected");
        for (const item of existingSetup) {
          logger.info(item);
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
        default: DEFAULT_CONFIG.api_endpoint,
      });

      // Prompt for output folder location
      const outputFolder = await input({
        message: "Where should generated API files be placed?",
        default: DEFAULT_CONFIG.output.folder,
        validate: (value) =>
          value.trim().length > 0 || "Output folder is required",
      });

      // Detect package manager and confirm with user
      const detectedPm = await detectPackageManager(projectRoot);
      const pm: PackageManager = await select({
        message: "Which package manager are you using?",
        choices: [
          { name: "pnpm", value: "pnpm" as const },
          { name: "npm", value: "npm" as const },
          { name: "yarn", value: "yarn" as const },
          { name: "bun", value: "bun" as const },
        ],
        default: detectedPm,
      });

      // Auto-detect env accessor from framework config files
      let envAccessor = flags["env-accessor"];
      if (envAccessor === DEFAULT_INSTANCE_CONFIG.env_accessor) {
        const hasViteConfig = await this.hasFile(projectRoot, [
          "vite.config.ts", "vite.config.js", "vite.config.mts",
        ]);
        if (hasViteConfig) {
          envAccessor = "import.meta.env";
          logger.info("Detected Vite project — using import.meta.env");
        }
      }

      // Prompt for auth mode
      const authMode: AuthMode = await select({
        message: "How should auth tokens be attached to requests?",
        choices: [
          { name: "Bearer token from localStorage (SPA pattern)", value: "bearer-localstorage" as const },
          { name: "Custom — I'll implement my own auth logic", value: "custom" as const },
          { name: "None — no auth interceptor needed", value: "none" as const },
        ],
        default: flags["auth-mode"] as AuthMode,
      });

      // Build instance config from flags and prompts
      const instanceConfig: InstanceConfig = {
        base_url_env: flags["base-url-env"],
        env_accessor: envAccessor,
        token_key: flags["token-key"],
        auth_mode: authMode,
        with_credentials: flags["with-credentials"],
        timeout: flags.timeout,
      };

      // Step 1: Create api.config.toml
      await this.setupConfig(
        projectRoot,
        flags,
        instanceConfig,
        apiEndpoint,
        outputFolder,
        logger
      );

      // Step 2: Install axios dependency
      await this.ensureAxios(projectRoot, pm, logger);

      // Step 3: Add npm scripts to package.json
      if (!flags["skip-scripts"]) {
        await this.setupScripts(projectRoot, flags, logger);
      }

      // Step 4: Setup concurrent dev script (optional)
      if (!flags["skip-concurrent"]) {
        await this.setupConcurrentlyScript(projectRoot, pm, logger);
      }

      // Step 5: Generate client files
      if (!flags["skip-client"]) {
        await this.setupClientFiles(projectRoot, instanceConfig, flags, logger);
      }

      // Step 6: Run initial fetch (if not localhost default)
      const isLocalhost =
        apiEndpoint.includes("localhost") || apiEndpoint.includes("127.0.0.1");
      if (!isLocalhost) {
        await this.runInitialFetch(projectRoot, pm, logger);
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
   * Runs initial fetch to download spec and generate types.
   */
  private async runInitialFetch(
    projectRoot: string,
    pm: PackageManager,
    logger: ReturnType<typeof createLogger>
  ): Promise<void> {
    logger.step("fetch", "Fetching OpenAPI spec and generating types...");

    const [cmd, ...dlxArgs] = getDlxCommand(pm);
    const result = spawnSync(cmd, [...dlxArgs, "chowbea-axios", "fetch"], {
      cwd: projectRoot,
      stdio: "inherit",
    });

    const runCmd = getRunCommand(pm);
    if (result.status !== 0) {
      logger.warn(
        `Initial fetch failed - you can run '${runCmd} api:fetch' later`
      );
    } else {
      logger.info("Types generated successfully");
    }
  }

  /**
   * Ensures axios is installed as a dependency.
   */
  private async ensureAxios(
    projectRoot: string,
    pm: PackageManager,
    logger: ReturnType<typeof createLogger>
  ): Promise<void> {
    // Check if already installed
    const packageJsonPath = path.join(projectRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const deps = packageJson.dependencies || {};

    if (deps.axios) {
      logger.info("axios already installed");
      return;
    }

    logger.step("deps", "Installing axios...");

    const [cmd, ...args] = getInstallCommand(pm, "axios");
    const result = spawnSync(cmd, args, {
      cwd: projectRoot,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      logger.warn("Failed to install axios - please install it manually");
    } else {
      logger.info("axios installed");
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
    outputFolder: string,
    logger: ReturnType<typeof createLogger>
  ): Promise<void> {
    const configPath = getConfigPath(projectRoot);
    const exists = await configExists(configPath);

    logger.step("config", "Creating api.config.toml...");

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

    // Generate config using shared template function
    const configContent = generateConfigTemplate({
      api_endpoint: apiEndpoint,
      poll_interval_ms: 10_000,
      output: { folder: outputFolder },
      instance: instanceConfig,
      watch: { debug: false },
    });
    await writeFile(configPath, configContent, "utf8");
    logger.info({ path: configPath }, "Created api.config.toml");
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

    logger.step("scripts", "Setting up npm scripts...");

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
    logger.step("client", "Generating client files...");

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
   * Sets up a concurrent watch script combining api:watch with user-selected dev scripts.
   * Uses concurrently to run multiple scripts in parallel with labeled output.
   */
  private async setupConcurrentlyScript(
    projectRoot: string,
    pm: PackageManager,
    logger: ReturnType<typeof createLogger>
  ): Promise<void> {
    // Ask if user wants concurrent dev mode
    const wantsConcurrent = await confirm({
      message:
        "Would you like to create a script that runs api:watch alongside your dev server?",
      default: true,
    });

    if (!wantsConcurrent) {
      logger.info("Skipped concurrent script setup");
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
        name: `${name}: ${scripts[name].slice(0, 50)}${
          scripts[name].length > 50 ? "..." : ""
        }`,
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

    // Use the confirmed package manager for the run command
    const runCmd = getRunCommand(pm);

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
    pm: PackageManager,
    logger: ReturnType<typeof createLogger>
  ): Promise<void> {
    const packageJsonPath = path.join(projectRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const devDeps = packageJson.devDependencies || {};

    if (devDeps.concurrently) {
      logger.debug("concurrently already installed");
      return;
    }

    logger.step("deps", "Installing concurrently...");

    const [cmd, ...args] = getInstallCommand(pm, "concurrently", true);
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

  /**
   * Checks if any of the given filenames exist in the project root.
   */
  private async hasFile(
    projectRoot: string,
    filenames: string[]
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
}
