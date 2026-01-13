/**
 * Validate command - validates OpenAPI spec structure and reports issues.
 */

import { Command, Flags } from "@oclif/core";

import {
	ensureOutputFolder,
	getOutputPaths,
	loadConfig,
} from "../lib/config.js";
import {
	formatError,
	SpecNotFoundError,
	ValidationError,
} from "../lib/errors.js";
import { hasLocalSpec, loadLocalSpec } from "../lib/fetcher.js";
import { createLogger, getLogLevel, logSeparator } from "../lib/logger.js";

/**
 * Validation issue with severity and location.
 */
interface ValidationIssue {
	severity: "error" | "warning";
	path: string;
	message: string;
}

/**
 * Validate OpenAPI spec structure.
 */
export default class Validate extends Command {
	static override description =
		`Check OpenAPI spec for issues that could affect generation.

Reports:
- Missing operationIds (operations will be skipped)
- Missing response definitions
- Invalid spec structure

Use --strict to treat warnings as errors.`;

	static override examples = [
		{
			command: "<%= config.bin %> validate",
			description: "Validate cached spec",
		},
		{
			command: "<%= config.bin %> validate --strict",
			description: "Fail on warnings too",
		},
		{
			command: "<%= config.bin %> validate --spec ./openapi.json",
			description: "Validate specific file",
		},
	];

	static override flags = {
		config: Flags.string({
			char: "c",
			description: "Path to api.config.toml",
		}),
		spec: Flags.string({
			char: "s",
			description: "Path to OpenAPI spec file (overrides config)",
		}),
		strict: Flags.boolean({
			description: "Treat warnings as errors",
			default: false,
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
		const { flags } = await this.parse(Validate);

		// Create logger with appropriate level
		const logger = createLogger({
			level: getLogLevel(flags),
		});

		logSeparator(logger, "chowbea-axios validate");

		try {
			// Determine spec path
			let specPath: string;

			if (flags.spec) {
				specPath = flags.spec;
			} else {
				// Load config to get output path
				const { config, projectRoot } = await loadConfig(flags.config);
				const outputPaths = getOutputPaths(config, projectRoot);
				await ensureOutputFolder(outputPaths.folder);
				specPath = outputPaths.spec;
			}

			logger.info({ specPath }, "Validating OpenAPI spec...");

			// Check if spec exists
			const exists = await hasLocalSpec(specPath);

			if (!exists) {
				throw new SpecNotFoundError(specPath);
			}

			// Load and parse spec
			const { spec } = await loadLocalSpec(specPath);

			// Run validations
			const issues = this.validateSpec(spec);

			// Report issues
			const errors = issues.filter((i) => i.severity === "error");
			const warnings = issues.filter((i) => i.severity === "warning");

			if (errors.length > 0) {
				logSeparator(logger, "Errors");
				for (const issue of errors) {
					logger.error({ path: issue.path }, issue.message);
				}
			}

			if (warnings.length > 0) {
				logSeparator(logger, "Warnings");
				for (const issue of warnings) {
					logger.warn({ path: issue.path }, issue.message);
				}
			}

			// Summary
			logSeparator(logger);
			logger.info(
				{ errors: errors.length, warnings: warnings.length },
				"Validation complete"
			);

			// Exit with error if strict mode and warnings exist, or if errors exist
			if (errors.length > 0 || (flags.strict && warnings.length > 0)) {
				const allIssues = flags.strict ? issues : errors;
				throw new ValidationError(
					allIssues.map((i) => `${i.path}: ${i.message}`)
				);
			}

			logger.info("OpenAPI spec is valid");
		} catch (error) {
			if (error instanceof ValidationError) {
				this.exit(1);
			}
			logger.error(formatError(error));
			this.exit(1);
		}
	}

	/**
	 * Validates the OpenAPI spec and returns a list of issues.
	 */
	private validateSpec(spec: unknown): ValidationIssue[] {
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
}
