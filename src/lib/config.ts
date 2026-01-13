/**
 * Configuration loader with auto-create functionality.
 * Finds project root, loads api.config.toml, and auto-creates if missing.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import toml from "toml";

import { ConfigError, ConfigValidationError } from "./errors.js";

/**
 * Fetch configuration for remote spec retrieval.
 */
export interface FetchConfig {
  /** Headers to include when fetching the OpenAPI spec */
  headers?: Record<string, string>;
}

/**
 * Watch mode configuration for controlling debug output.
 */
export interface WatchConfig {
  /** Enable debug logging in watch mode (shows cycle-by-cycle logs) */
  debug: boolean;
}

/**
 * Instance configuration for the generated axios client.
 */
export interface InstanceConfig {
  /** Environment variable name for base URL (e.g., "VITE_API_URL") */
  base_url_env: string;
  /** localStorage key for auth token */
  token_key: string;
  /** Whether to include credentials (cookies) in requests */
  with_credentials: boolean;
  /** Request timeout in milliseconds */
  timeout: number;
}

/**
 * Configuration structure for api.config.toml
 */
export interface ApiConfig {
  /** Remote OpenAPI spec endpoint URL */
  api_endpoint: string;
  /** Local spec file path (takes priority over api_endpoint if set) */
  spec_file?: string;
  /** Polling interval in milliseconds for watch mode */
  poll_interval_ms: number;
  /** Output configuration */
  output: {
    /** Folder where all generated files are written */
    folder: string;
  };
  /** Fetch configuration for remote spec retrieval */
  fetch?: FetchConfig;
  /** Instance configuration for the generated axios client */
  instance: InstanceConfig;
  /** Watch mode configuration */
  watch: WatchConfig;
}

/**
 * Default watch configuration values.
 */
export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  debug: false,
};

/**
 * Default instance configuration values.
 */
export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  base_url_env: "VITE_API_URL",
  token_key: "auth-token",
  with_credentials: true,
  timeout: 30_000,
};

/**
 * Default configuration values used when auto-creating config.
 */
export const DEFAULT_CONFIG: ApiConfig = {
  api_endpoint: "http://localhost:3000/docs/swagger/json",
  spec_file: undefined,
  poll_interval_ms: 10_000,
  output: {
    folder: "app/services/api",
  },
  fetch: undefined,
  instance: DEFAULT_INSTANCE_CONFIG,
  watch: DEFAULT_WATCH_CONFIG,
};

/**
 * Default config file template with comments.
 */
const CONFIG_TEMPLATE = `# Chowbea Axios Configuration

api_endpoint = "http://localhost:3000/docs/swagger/json"
# spec_file = "./openapi.json"  # Use local file instead of remote
poll_interval_ms = 10000

[output]
folder = "app/services/api"

[instance]
base_url_env = "VITE_API_URL"
token_key = "auth-token"
with_credentials = true
timeout = 30000

[watch]
debug = false
`;

/**
 * Finds the project root by walking up to the nearest package.json.
 * Returns the directory containing package.json.
 */
export async function findProjectRoot(startDir?: string): Promise<string> {
  let currentDir = startDir ?? process.cwd();

  // Walk up the directory tree looking for package.json
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, "package.json");

    try {
      await access(packageJsonPath);
      return currentDir;
    } catch {
      // package.json not found, continue walking up
      currentDir = path.dirname(currentDir);
    }
  }

  // No package.json found, use the starting directory
  return startDir ?? process.cwd();
}

/**
 * Gets the path to api.config.toml relative to project root.
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, "api.config.toml");
}

/**
 * Checks if a config file exists at the given path.
 */
export async function configExists(configPath: string): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a default config file at the specified path.
 */
export async function createDefaultConfig(configPath: string): Promise<void> {
  const configDir = path.dirname(configPath);

  // Ensure directory exists
  await mkdir(configDir, { recursive: true });

  // Write the config template
  await writeFile(configPath, CONFIG_TEMPLATE, "utf8");
}

/**
 * Validates the watch configuration section.
 */
function validateWatchConfig(watch: unknown): WatchConfig {
  // If watch section is missing, use defaults
  if (watch === undefined || watch === null) {
    return DEFAULT_WATCH_CONFIG;
  }

  if (typeof watch !== "object") {
    throw new ConfigValidationError("watch", "watch section must be an object");
  }

  const w = watch as Record<string, unknown>;

  // Validate or use default for debug field
  const debug =
    typeof w.debug === "boolean" ? w.debug : DEFAULT_WATCH_CONFIG.debug;

  return { debug };
}

/**
 * Validates the instance configuration section.
 */
function validateInstanceConfig(instance: unknown): InstanceConfig {
  // If instance section is missing, use defaults
  if (instance === undefined || instance === null) {
    return DEFAULT_INSTANCE_CONFIG;
  }

  if (typeof instance !== "object") {
    throw new ConfigValidationError(
      "instance",
      "instance section must be an object"
    );
  }

  const inst = instance as Record<string, unknown>;

  // Validate or use defaults for each field
  const base_url_env =
    typeof inst.base_url_env === "string" && inst.base_url_env.trim().length > 0
      ? inst.base_url_env
      : DEFAULT_INSTANCE_CONFIG.base_url_env;

  const token_key =
    typeof inst.token_key === "string" && inst.token_key.trim().length > 0
      ? inst.token_key
      : DEFAULT_INSTANCE_CONFIG.token_key;

  const with_credentials =
    typeof inst.with_credentials === "boolean"
      ? inst.with_credentials
      : DEFAULT_INSTANCE_CONFIG.with_credentials;

  const timeout =
    typeof inst.timeout === "number" && inst.timeout > 0
      ? inst.timeout
      : DEFAULT_INSTANCE_CONFIG.timeout;

  return { base_url_env, token_key, with_credentials, timeout };
}

/**
 * Validates the loaded configuration and throws descriptive errors.
 */
function validateConfig(config: unknown): ApiConfig {
  if (typeof config !== "object" || config === null) {
    throw new ConfigValidationError("root", "Configuration must be an object");
  }

  const cfg = config as Record<string, unknown>;

  // Validate api_endpoint
  if (
    typeof cfg.api_endpoint !== "string" ||
    cfg.api_endpoint.trim().length === 0
  ) {
    throw new ConfigValidationError(
      "api_endpoint",
      "api_endpoint must be a non-empty string URL"
    );
  }

  // Validate poll_interval_ms
  if (typeof cfg.poll_interval_ms !== "number" || cfg.poll_interval_ms < 1000) {
    throw new ConfigValidationError(
      "poll_interval_ms",
      "poll_interval_ms must be a number >= 1000"
    );
  }

  // Validate output section
  if (typeof cfg.output !== "object" || cfg.output === null) {
    throw new ConfigValidationError("output", "output section is required");
  }

  const output = cfg.output as Record<string, unknown>;

  if (typeof output.folder !== "string" || output.folder.trim().length === 0) {
    throw new ConfigValidationError(
      "output.folder",
      "output.folder must be a non-empty string path"
    );
  }

  // Validate spec_file if provided (optional)
  const spec_file =
    typeof cfg.spec_file === "string" && cfg.spec_file.trim().length > 0
      ? cfg.spec_file
      : undefined;

  // Validate fetch section if provided (optional)
  const fetchConfig = validateFetchConfig(cfg.fetch);

  // Validate instance section (uses defaults if missing)
  const instance = validateInstanceConfig(cfg.instance);

  // Validate watch section (uses defaults if missing)
  const watch = validateWatchConfig(cfg.watch);

  return {
    api_endpoint: cfg.api_endpoint,
    spec_file,
    poll_interval_ms: cfg.poll_interval_ms,
    output: {
      folder: output.folder,
    },
    fetch: fetchConfig,
    instance,
    watch,
  };
}

/**
 * Validates the fetch configuration section.
 */
function validateFetchConfig(fetch: unknown): FetchConfig | undefined {
  // If fetch section is missing, return undefined
  if (fetch === undefined || fetch === null) {
    return;
  }

  if (typeof fetch !== "object") {
    throw new ConfigValidationError("fetch", "fetch section must be an object");
  }

  const fetchObj = fetch as Record<string, unknown>;

  // Validate headers if provided
  let headers: Record<string, string> | undefined;
  if (fetchObj.headers !== undefined && fetchObj.headers !== null) {
    if (typeof fetchObj.headers !== "object") {
      throw new ConfigValidationError(
        "fetch.headers",
        "fetch.headers must be an object"
      );
    }

    const headersObj = fetchObj.headers as Record<string, unknown>;
    headers = {};

    for (const [key, value] of Object.entries(headersObj)) {
      if (typeof value !== "string") {
        throw new ConfigValidationError(
          `fetch.headers.${key}`,
          "header value must be a string"
        );
      }
      headers[key] = value;
    }
  }

  return headers ? { headers } : undefined;
}

/**
 * Spec source types for determining where to load the spec from.
 */
export type SpecSource =
  | { type: "local"; path: string }
  | { type: "remote"; endpoint: string };

/**
 * Resolves the spec source based on config and flag overrides.
 * Priority: flag > config spec_file > config api_endpoint
 */
export function resolveSpecSource(
  config: ApiConfig,
  projectRoot: string,
  flagSpecFile?: string
): SpecSource {
  // Flag takes highest priority
  if (flagSpecFile) {
    const resolvedPath = path.isAbsolute(flagSpecFile)
      ? flagSpecFile
      : path.join(projectRoot, flagSpecFile);
    return { type: "local", path: resolvedPath };
  }

  // Config spec_file takes second priority
  if (config.spec_file) {
    const resolvedPath = path.isAbsolute(config.spec_file)
      ? config.spec_file
      : path.join(projectRoot, config.spec_file);
    return { type: "local", path: resolvedPath };
  }

  // Default to remote endpoint
  return { type: "remote", endpoint: config.api_endpoint };
}

/**
 * Loads and parses the configuration file.
 * Auto-creates with defaults if missing.
 */
export async function loadConfig(configPath?: string): Promise<{
  config: ApiConfig;
  projectRoot: string;
  configPath: string;
  wasCreated: boolean;
}> {
  // Find project root
  const projectRoot = await findProjectRoot();
  const resolvedConfigPath = configPath ?? getConfigPath(projectRoot);

  // Check if config exists
  const exists = await configExists(resolvedConfigPath);

  if (!exists) {
    // Auto-create config with defaults
    await createDefaultConfig(resolvedConfigPath);

    return {
      config: DEFAULT_CONFIG,
      projectRoot,
      configPath: resolvedConfigPath,
      wasCreated: true,
    };
  }

  // Load and parse existing config
  try {
    const content = await readFile(resolvedConfigPath, "utf8");
    const parsed = toml.parse(content);
    const config = validateConfig(parsed);

    return {
      config,
      projectRoot,
      configPath: resolvedConfigPath,
      wasCreated: false,
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes("Unexpected")) {
      throw new ConfigError(
        `Failed to parse api.config.toml: ${error.message}`,
        "Check your TOML syntax. Run 'chowbea-axios init --force' to regenerate with defaults."
      );
    }

    throw new ConfigError(
      `Failed to load config: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Resolves the output folder path to an absolute path.
 */
export function resolveOutputFolder(
  config: ApiConfig,
  projectRoot: string
): string {
  return path.isAbsolute(config.output.folder)
    ? config.output.folder
    : path.join(projectRoot, config.output.folder);
}

/**
 * Output paths for all generated files.
 */
export interface OutputPaths {
  /** Root output folder */
  folder: string;
  /** _internal folder for cache files */
  internal: string;
  /** _generated folder for auto-generated code */
  generated: string;
  /** Path to api.types.ts (generated types) */
  types: string;
  /** Path to api.operations.ts (generated operations) */
  operations: string;
  /** Path to api.helpers.ts (utility types - generated once) */
  helpers: string;
  /** Path to openapi.json spec file */
  spec: string;
  /** Path to .api-cache.json */
  cache: string;
  /** Path to api.instance.ts (axios instance - generated once) */
  instance: string;
  /** Path to api.error.ts (error handling - generated once) */
  error: string;
  /** Path to api.client.ts (typed facade - generated once) */
  client: string;
}

/**
 * Gets paths for all generated files based on config.
 */
export function getOutputPaths(
  config: ApiConfig,
  projectRoot: string
): OutputPaths {
  const folder = resolveOutputFolder(config, projectRoot);
  const internal = path.join(folder, "_internal");
  const generated = path.join(folder, "_generated");

  return {
    folder,
    internal,
    generated,
    // _internal/ files (always overwritten)
    spec: path.join(internal, "openapi.json"),
    cache: path.join(internal, ".api-cache.json"),
    // _generated/ files (always overwritten)
    types: path.join(generated, "api.types.ts"),
    operations: path.join(generated, "api.operations.ts"),
    // Root files (generated once, user-editable)
    helpers: path.join(folder, "api.helpers.ts"),
    instance: path.join(folder, "api.instance.ts"),
    error: path.join(folder, "api.error.ts"),
    client: path.join(folder, "api.client.ts"),
  };
}

/**
 * Ensures the output folder and subfolders exist, creating them if necessary.
 */
export async function ensureOutputFolder(outputFolder: string): Promise<void> {
  await mkdir(outputFolder, { recursive: true });
}

/**
 * Ensures all output folders exist (_internal, _generated, and root).
 */
export async function ensureOutputFolders(paths: OutputPaths): Promise<void> {
  await mkdir(paths.internal, { recursive: true });
  await mkdir(paths.generated, { recursive: true });
}
