/**
 * Validate action - validates OpenAPI spec structure and reports issues.
 * Returns structured validation results; does not throw on validation failure.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import {
	ensureOutputFolder,
	getOutputPaths,
	loadConfig,
} from "../config.js";
import { formatError, SpecNotFoundError } from "../errors.js";
import { hasLocalSpec, loadLocalSpec } from "../fetcher.js";

/**
 * Options for the validate action.
 */
export interface ValidateActionOptions {
	configPath?: string;
	specFile?: string;
	strict?: boolean;
}

/**
 * A single validation issue with severity and location.
 */
export interface ValidationIssue {
	severity: "error" | "warning";
	path: string;
	message: string;
}

/**
 * Result of the validate action.
 */
export interface ValidateResult {
	issues: ValidationIssue[];
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
	valid: boolean;
}

/**
 * Validates the OpenAPI spec and returns a list of issues.
 */
export function validateSpec(spec: unknown): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (typeof spec !== "object" || spec === null) {
		issues.push({
			severity: "error",
			path: "/",
			message: "Spec must be a valid JSON object",
		});
		return issues;
	}

	const specObj = spec as Record<string, unknown>;

	// Check for required OpenAPI fields
	if (!(specObj.openapi || specObj.swagger)) {
		issues.push({
			severity: "error",
			path: "/",
			message: "Missing 'openapi' or 'swagger' version field",
		});
	}

	if (!specObj.info) {
		issues.push({
			severity: "error",
			path: "/info",
			message: "Missing required 'info' object",
		});
	}

	if (specObj.paths) {
		// Validate paths
		const paths = specObj.paths as Record<string, unknown>;

		for (const [pathKey, pathItem] of Object.entries(paths)) {
			if (typeof pathItem !== "object" || pathItem === null) {
				issues.push({
					severity: "error",
					path: `/paths${pathKey}`,
					message: "Path item must be an object",
				});
				continue;
			}

			const pathObj = pathItem as Record<string, unknown>;

			// Check each HTTP method
			for (const method of ["get", "post", "put", "delete", "patch"]) {
				const operation = pathObj[method] as
					| Record<string, unknown>
					| undefined;

				if (!operation) continue;

				// Check for operationId
				if (!operation.operationId) {
					issues.push({
						severity: "warning",
						path: `/paths${pathKey}/${method}`,
						message:
							"Missing operationId - operation will be skipped during generation",
					});
				}

				// Check for responses
				if (!operation.responses) {
					issues.push({
						severity: "warning",
						path: `/paths${pathKey}/${method}`,
						message: "Missing responses definition",
					});
				}
			}
		}
	} else {
		issues.push({
			severity: "warning",
			path: "/paths",
			message: "No paths defined in spec",
		});
	}

	// Check for components/schemas
	if (specObj.components) {
		const components = specObj.components as Record<string, unknown>;

		if (!components.schemas) {
			issues.push({
				severity: "warning",
				path: "/components",
				message: "No schemas defined in components",
			});
		}
	}

	return issues;
}

/**
 * Executes the validate action: loads the spec and runs validation.
 * Returns structured results without throwing on validation failure.
 */
export async function executeValidate(
	options: ValidateActionOptions,
	logger: Logger
): Promise<ValidateResult> {
	try {
		// Determine spec path
		let specPath: string;

		if (options.specFile) {
			specPath = options.specFile;
		} else {
			// Load config to get output path
			const { config, projectRoot } = await loadConfig(options.configPath);
			const outputPaths = getOutputPaths(config, projectRoot);
			await ensureOutputFolder(outputPaths.folder);
			specPath = outputPaths.spec;
		}

		logger.debug({ specPath }, "spec path");

		// Check if spec exists
		const exists = await hasLocalSpec(specPath);

		if (!exists) {
			throw new SpecNotFoundError(specPath);
		}

		// Load and parse spec
		const { spec } = await loadLocalSpec(specPath);

		// Run validations
		const issues = validateSpec(spec);

		// Separate errors and warnings
		const errors = issues.filter((i) => i.severity === "error");
		const warnings = issues.filter((i) => i.severity === "warning");

		// Determine validity based on strict mode
		const valid = options.strict
			? issues.length === 0
			: errors.length === 0;

		return {
			issues,
			errors,
			warnings,
			valid,
		};
	} catch (error) {
		if (error instanceof SpecNotFoundError) {
			throw error;
		}

		logger.error(formatError(error));
		throw error;
	}
}
