/**
 * OpenAPI spec fetcher with retry logic and caching.
 * Supports graceful fallback to cached spec on network failures.
 */

import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";

import { NetworkError, SpecNotFoundError } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * Cache metadata stored in .api-cache.json
 */
export interface CacheMetadata {
	/** SHA256 hash of the OpenAPI spec content */
	hash: string;
	/** Timestamp when the spec was last fetched */
	timestamp: number;
	/** The endpoint URL used to fetch the spec */
	endpoint: string;
}

/**
 * Result of fetching the OpenAPI spec.
 */
export interface FetchResult {
	/** The raw spec content as a Buffer */
	buffer: Buffer;
	/** SHA256 hash of the content */
	hash: string;
	/** Whether the spec has changed since last fetch */
	hasChanged: boolean;
	/** Whether this was loaded from cache due to network failure */
	fromCache: boolean;
}

/**
 * Retry configuration for network operations.
 */
export interface RetryConfig {
	/** Maximum number of retry attempts (default: 3) */
	maxAttempts: number;
	/** Base delay between retries in ms (default: 1000) */
	baseDelay: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	baseDelay: 1000,
	backoffMultiplier: 2,
};

/**
 * Interpolates environment variables in a string.
 * Replaces $VAR_NAME or ${VAR_NAME} with the environment variable value.
 * Throws if a referenced env var is not set.
 */
export function interpolateEnvVars(value: string): string {
	// Match $VAR_NAME or ${VAR_NAME}
	return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (_match, varName) => {
		const envValue = process.env[varName];
		if (envValue === undefined) {
			throw new Error(
				`Environment variable ${varName} is not set (referenced in: ${value})`
			);
		}
		return envValue;
	});
}

/**
 * Interpolates environment variables in all header values.
 */
export function interpolateHeaders(
	headers: Record<string, string>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key] = interpolateEnvVars(value);
	}
	return result;
}

/**
 * Computes SHA256 hash of a buffer.
 */
export function computeHash(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Delays execution for the specified milliseconds.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Loads cache metadata from the cache file.
 * Returns null if cache doesn't exist or is corrupted.
 */
export async function loadCacheMetadata(
	cachePath: string
): Promise<CacheMetadata | null> {
	try {
		await access(cachePath);
		const content = await readFile(cachePath, "utf8");
		const parsed = JSON.parse(content) as CacheMetadata;

		// Validate cache structure
		if (
			typeof parsed.hash === "string" &&
			typeof parsed.timestamp === "number" &&
			typeof parsed.endpoint === "string"
		) {
			return parsed;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Saves cache metadata to the cache file.
 */
export async function saveCacheMetadata(
	cachePath: string,
	metadata: CacheMetadata
): Promise<void> {
	await writeFile(cachePath, JSON.stringify(metadata, null, 2), "utf8");
}

/**
 * Loads the cached OpenAPI spec from disk.
 * Returns null if spec doesn't exist.
 */
export async function loadCachedSpec(specPath: string): Promise<Buffer | null> {
	try {
		await access(specPath);
		return await readFile(specPath);
	} catch {
		return null;
	}
}

/**
 * Fetches the OpenAPI spec from a remote endpoint with retry logic.
 * Falls back to cached spec on network failure.
 */
export async function fetchOpenApiSpec(options: {
	endpoint: string;
	specPath: string;
	cachePath: string;
	logger: Logger;
	force?: boolean;
	retryConfig?: RetryConfig;
	headers?: Record<string, string>;
}): Promise<FetchResult> {
	const { endpoint, specPath, cachePath, logger, force = false } = options;
	const retryConfig = options.retryConfig ?? DEFAULT_RETRY_CONFIG;

	// Interpolate env vars in headers
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (options.headers) {
		try {
			const interpolated = interpolateHeaders(options.headers);
			Object.assign(headers, interpolated);
		} catch (error) {
			throw new Error(
				`Failed to interpolate headers: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	// Load existing cache metadata
	const existingCache = await loadCacheMetadata(cachePath);

	// Attempt to fetch with retries
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
		try {
			logger.debug({ attempt, endpoint }, "Fetching OpenAPI spec...");

			const response = await fetch(endpoint, {
				headers,
			});

			if (!response.ok) {
				throw new NetworkError(
					endpoint,
					`HTTP ${response.status}: ${response.statusText}`,
					response.status
				);
			}

			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			const hash = computeHash(buffer);

			// Check if content has changed
			const hasChanged = force || !existingCache || existingCache.hash !== hash;

			logger.debug(
				{ hash, hasChanged, bytes: buffer.length },
				"Spec fetched successfully"
			);

			return {
				buffer,
				hash,
				hasChanged,
				fromCache: false,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < retryConfig.maxAttempts) {
				const delayMs =
					retryConfig.baseDelay *
					retryConfig.backoffMultiplier ** (attempt - 1);

				logger.warn(
					{
						attempt,
						maxAttempts: retryConfig.maxAttempts,
						delayMs,
						error: lastError.message,
					},
					"Fetch failed, retrying..."
				);

				await delay(delayMs);
			}
		}
	}

	// All retries failed - try to fall back to cached spec
	logger.warn(
		{ attempts: retryConfig.maxAttempts, error: lastError?.message },
		"All fetch attempts failed, checking for cached spec..."
	);

	const cachedSpec = await loadCachedSpec(specPath);

	if (cachedSpec && existingCache) {
		logger.info("Using cached OpenAPI spec due to network failure");

		return {
			buffer: cachedSpec,
			hash: existingCache.hash,
			hasChanged: false, // Don't regenerate if using cached
			fromCache: true,
		};
	}

	// No cache available - throw the network error
	throw new NetworkError(
		endpoint,
		`Failed to fetch OpenAPI spec after ${retryConfig.maxAttempts} attempts: ${lastError?.message}`
	);
}

/**
 * Saves the fetched spec and updates cache metadata.
 */
export async function saveSpec(options: {
	buffer: Buffer;
	hash: string;
	endpoint: string;
	specPath: string;
	cachePath: string;
}): Promise<void> {
	const { buffer, hash, endpoint, specPath, cachePath } = options;

	// Write spec file
	await writeFile(specPath, buffer);

	// Update cache metadata
	await saveCacheMetadata(cachePath, {
		hash,
		timestamp: Date.now(),
		endpoint,
	});
}

/**
 * Checks if the local spec exists and is valid.
 */
export async function hasLocalSpec(specPath: string): Promise<boolean> {
	try {
		await access(specPath);
		const content = await readFile(specPath, "utf8");
		JSON.parse(content); // Verify it's valid JSON
		return true;
	} catch {
		return false;
	}
}

/**
 * Loads and parses the local OpenAPI spec.
 * Throws SpecNotFoundError if not found.
 */
export async function loadLocalSpec(specPath: string): Promise<{
	spec: unknown;
	buffer: Buffer;
}> {
	try {
		await access(specPath);
	} catch {
		throw new SpecNotFoundError(specPath);
	}

	const buffer = await readFile(specPath);
	const content = buffer.toString("utf8");

	try {
		const spec = JSON.parse(content);
		return { spec, buffer };
	} catch (error) {
		throw new Error(
			`Failed to parse OpenAPI spec: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Loads a spec from a local file and copies it to the cache location.
 * Returns a FetchResult-like object for consistency with remote fetching.
 */
export async function loadLocalSpecFile(options: {
	localPath: string;
	specPath: string;
	cachePath: string;
	logger: Logger;
	force?: boolean;
}): Promise<FetchResult> {
	const { localPath, cachePath, logger, force = false } = options;

	logger.info({ localPath }, "Loading local spec file...");

	// Load existing cache metadata
	const existingCache = await loadCacheMetadata(cachePath);

	// Load and parse the local file
	const { buffer } = await loadLocalSpec(localPath);
	const hash = computeHash(buffer);

	// Check if content has changed
	const hasChanged = force || !existingCache || existingCache.hash !== hash;

	logger.debug({ hash, hasChanged, bytes: buffer.length }, "Local spec loaded");

	return {
		buffer,
		hash,
		hasChanged,
		fromCache: false,
	};
}
