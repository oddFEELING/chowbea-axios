/**
 * Custom error classes with recovery hints for self-healing behavior.
 * Each error type provides actionable suggestions to help users recover.
 */

/**
 * Base error class with recovery hint support.
 */
export class ChowbeaAxiosError extends Error {
	public readonly recoveryHint: string;
	public readonly code: string;

	constructor(message: string, code: string, recoveryHint: string) {
		super(message);
		this.name = "ChowbeaAxiosError";
		this.code = code;
		this.recoveryHint = recoveryHint;
		Error.captureStackTrace(this, this.constructor);
	}
}

/**
 * Thrown when api.config.toml is missing or invalid.
 */
export class ConfigError extends ChowbeaAxiosError {
	constructor(message: string, recoveryHint?: string) {
		super(
			message,
			"CONFIG_ERROR",
			recoveryHint ??
				"Run 'chowbea-axios init' to create a default configuration file."
		);
		this.name = "ConfigError";
	}
}

/**
 * Thrown when the config file has invalid or missing values.
 */
export class ConfigValidationError extends ChowbeaAxiosError {
	public readonly field: string;

	constructor(field: string, message: string) {
		super(
			`Invalid configuration: ${message}`,
			"CONFIG_VALIDATION_ERROR",
			`Check your api.config.toml and ensure '${field}' is correctly set.`
		);
		this.name = "ConfigValidationError";
		this.field = field;
	}
}

/**
 * Thrown when network operations fail (fetching OpenAPI spec).
 */
export class NetworkError extends ChowbeaAxiosError {
	public readonly url: string;
	public readonly statusCode?: number;

	constructor(url: string, message: string, statusCode?: number) {
		super(
			message,
			"NETWORK_ERROR",
			statusCode === 404
				? `The OpenAPI endpoint was not found. Verify the 'api_endpoint' in api.config.toml.`
				: statusCode && statusCode >= 500
					? "The server returned an error. Try again later or check if the API server is running."
					: `Check your network connection and ensure the API endpoint is accessible: ${url}`
		);
		this.name = "NetworkError";
		this.url = url;
		this.statusCode = statusCode;
	}
}

/**
 * Thrown when the OpenAPI spec file is missing locally.
 */
export class SpecNotFoundError extends ChowbeaAxiosError {
	public readonly specPath: string;

	constructor(specPath: string) {
		super(
			`OpenAPI spec not found at: ${specPath}`,
			"SPEC_NOT_FOUND",
			"Run 'chowbea-axios fetch' to download the spec from the remote endpoint."
		);
		this.name = "SpecNotFoundError";
		this.specPath = specPath;
	}
}

/**
 * Thrown when the OpenAPI spec is invalid or cannot be parsed.
 */
export class SpecParseError extends ChowbeaAxiosError {
	public readonly specPath: string;

	constructor(specPath: string, parseError: string) {
		super(
			`Failed to parse OpenAPI spec: ${parseError}`,
			"SPEC_PARSE_ERROR",
			`The OpenAPI spec at '${specPath}' may be corrupted. Try running 'chowbea-axios fetch --force' to re-download it.`
		);
		this.name = "SpecParseError";
		this.specPath = specPath;
	}
}

/**
 * Thrown when code generation fails.
 */
export class GenerationError extends ChowbeaAxiosError {
	public readonly phase: string;

	constructor(phase: string, message: string) {
		super(
			`Generation failed during ${phase}: ${message}`,
			"GENERATION_ERROR",
			phase === "openapi-typescript"
				? "Ensure 'openapi-typescript' is available. Run 'pnpm add -D openapi-typescript' in the CLI directory."
				: "Check the error details above. Previous generated files have been preserved."
		);
		this.name = "GenerationError";
		this.phase = phase;
	}
}

/**
 * Thrown when output directory operations fail.
 */
export class OutputError extends ChowbeaAxiosError {
	public readonly outputPath: string;

	constructor(outputPath: string, message: string) {
		super(
			message,
			"OUTPUT_ERROR",
			`Check permissions for the output directory: ${outputPath}`
		);
		this.name = "OutputError";
		this.outputPath = outputPath;
	}
}

/**
 * Thrown when validation finds issues with the OpenAPI spec.
 */
export class ValidationError extends ChowbeaAxiosError {
	public readonly issues: string[];

	constructor(issues: string[]) {
		super(
			`OpenAPI spec validation failed with ${issues.length} issue(s)`,
			"VALIDATION_ERROR",
			"Review the issues listed above and fix them in your API definition."
		);
		this.name = "ValidationError";
		this.issues = issues;
	}
}

/**
 * Formats an error for display, including recovery hints.
 */
export function formatError(error: unknown): string {
	if (error instanceof ChowbeaAxiosError) {
		return [
			`Error [${error.code}]: ${error.message}`,
			"",
			`Recovery: ${error.recoveryHint}`,
		].join("\n");
	}

	if (error instanceof Error) {
		return `Error: ${error.message}`;
	}

	return `Unknown error: ${String(error)}`;
}

/**
 * Checks if an error is recoverable (can retry or use fallback).
 */
export function isRecoverable(error: unknown): boolean {
	if (error instanceof NetworkError) {
		// Network errors are generally recoverable via retry or cache fallback
		return true;
	}

	if (error instanceof SpecNotFoundError) {
		// Can recover by fetching the spec
		return true;
	}

	return false;
}
