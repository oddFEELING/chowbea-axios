/**
 * Validate action - validates OpenAPI spec structure and reports issues.
 * Returns structured validation results with category summaries.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import {
	ensureOutputFolder,
	getOutputPaths,
	loadConfig,
} from "../config.js";
import { formatError, SpecNotFoundError } from "../errors.js";
import { hasLocalSpec, loadLocalSpec } from "../fetcher.js";
import {
	resolveRef,
	resolveObject,
	resolveSchema,
	pickJsonContent,
	MAX_SCHEMA_DEPTH,
} from "../ref-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateActionOptions {
	configPath?: string;
	specFile?: string;
	strict?: boolean;
}

export type ValidationCategory =
	| "structure"
	| "operations"
	| "references"
	| "parameters"
	| "responses"
	| "type-quality"
	| "schemas";

export interface ValidationIssue {
	severity: "error" | "warning" | "info";
	category: ValidationCategory;
	path: string;
	message: string;
}

export interface CategorySummary {
	category: ValidationCategory;
	label: string;
	totalChecks: number;
	passed: number;
	failed: number;
	issues: ValidationIssue[];
}

export interface ValidateResult {
	issues: ValidationIssue[];
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
	valid: boolean;
	categories: CategorySummary[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Re-imported from the shared module so we cover all 8 OpenAPI methods,
// not just the 5 the runtime client can emit. Issue #31.
import { HTTP_METHODS } from "../http-methods.js";

interface CategoryResult {
	issues: ValidationIssue[];
	totalChecks: number;
}

function buildSummary(
	category: ValidationCategory,
	label: string,
	result: CategoryResult,
): CategorySummary {
	const failedCount = result.issues.filter(
		(i) => i.severity === "error" || i.severity === "warning",
	).length;
	return {
		category,
		label,
		totalChecks: result.totalChecks,
		passed: result.totalChecks - failedCount,
		failed: failedCount,
		issues: result.issues,
	};
}

/** Iterate all operations in the spec, calling `fn` for each. */
function forEachOperation(
	spec: Record<string, unknown>,
	fn: (pathKey: string, method: string, operation: Record<string, unknown>) => void,
): void {
	const paths = spec.paths as Record<string, unknown> | undefined;
	if (!paths || typeof paths !== "object") return;

	for (const [pathKey, pathItem] of Object.entries(paths)) {
		if (typeof pathItem !== "object" || pathItem === null) continue;
		const pathObj = pathItem as Record<string, unknown>;

		for (const method of HTTP_METHODS) {
			const operation = pathObj[method];
			if (!operation || typeof operation !== "object") continue;
			fn(pathKey, method, operation as Record<string, unknown>);
		}
	}
}

// ---------------------------------------------------------------------------
// Pattern detection helpers
// ---------------------------------------------------------------------------

/** SSE/streaming endpoint — response has text/event-stream content type. */
function isStreamingEndpoint(
	operation: Record<string, unknown>,
	spec: unknown,
): boolean {
	const responses = operation.responses as Record<string, unknown> | undefined;
	if (!responses) return false;
	return Object.values(responses).some((rawResp) => {
		if (!rawResp || typeof rawResp !== "object") return false;
		const resp = resolveObject(rawResp as Record<string, unknown>, spec);
		const content = resp.content as Record<string, unknown> | undefined;
		return content != null && "text/event-stream" in content;
	});
}

/** Action/trigger endpoint — POST/PATCH/PUT with no body but has a 2xx response. */
function isActionEndpoint(
	method: string,
	operation: Record<string, unknown>,
): boolean {
	if (method !== "post" && method !== "put" && method !== "patch") return false;
	if (operation.requestBody) return false;
	const responses = operation.responses as Record<string, unknown> | undefined;
	if (!responses) return false;
	return Object.keys(responses).some((code) =>
		["200", "201", "202", "204"].includes(code),
	);
}

/** Redirect endpoint — has 3xx responses but no 2xx responses. */
function isRedirectEndpoint(
	operation: Record<string, unknown>,
): boolean {
	const responses = operation.responses as Record<string, unknown> | undefined;
	if (!responses || Object.keys(responses).length === 0) return false;
	const codes = Object.keys(responses);
	const hasRedirect = codes.some((c) => c.startsWith("3"));
	const hasSuccess = codes.some((c) => c.startsWith("2"));
	return hasRedirect && !hasSuccess;
}

// ---------------------------------------------------------------------------
// Category validators
// ---------------------------------------------------------------------------

function validateStructure(spec: unknown): CategoryResult {
	const issues: ValidationIssue[] = [];
	let totalChecks = 0;

	// Check: valid JSON object
	totalChecks++;
	if (typeof spec !== "object" || spec === null) {
		issues.push({
			severity: "error",
			category: "structure",
			path: "/",
			message: "Spec must be a valid JSON object",
		});
		return { issues, totalChecks };
	}

	const specObj = spec as Record<string, unknown>;

	// Check: openapi or swagger field
	totalChecks++;
	if (!(specObj.openapi || specObj.swagger)) {
		issues.push({
			severity: "error",
			category: "structure",
			path: "/",
			message: "Missing 'openapi' or 'swagger' version field",
		});
	}

	// Check: info object with title
	totalChecks++;
	const info = specObj.info as Record<string, unknown> | undefined;
	if (!info || typeof info !== "object") {
		issues.push({
			severity: "error",
			category: "structure",
			path: "/info",
			message: "Missing required 'info' object",
		});
	} else if (!info.title) {
		issues.push({
			severity: "warning",
			category: "structure",
			path: "/info",
			message: "Missing 'title' in info object",
		});
	}

	// Check: paths defined
	totalChecks++;
	if (!specObj.paths || typeof specObj.paths !== "object") {
		issues.push({
			severity: "warning",
			category: "structure",
			path: "/paths",
			message: "No paths defined in spec",
		});
	}

	return { issues, totalChecks };
}

function validateOperations(spec: Record<string, unknown>): CategoryResult {
	const issues: ValidationIssue[] = [];
	let totalChecks = 0;

	// Collect all operationIds to detect duplicates
	const operationIdMap = new Map<string, string[]>();

	forEachOperation(spec, (pathKey, method, operation) => {
		const opPath = `/paths${pathKey}/${method}`;

		// Check: has operationId
		totalChecks++;
		if (!operation.operationId || typeof operation.operationId !== "string") {
			issues.push({
				severity: "error",
				category: "operations",
				path: opPath,
				message: "Missing operationId — operation will be SKIPPED during generation",
			});
		} else {
			const id = operation.operationId as string;
			const existing = operationIdMap.get(id);
			if (existing) {
				existing.push(opPath);
			} else {
				operationIdMap.set(id, [opPath]);
			}
		}

		// Check: has successful response (2xx)
		totalChecks++;
		const responses = operation.responses as Record<string, unknown> | undefined;
		if (responses && typeof responses === "object") {
			const hasSuccess = Object.keys(responses).some((code) =>
				code.startsWith("2"),
			);
			if (!hasSuccess) {
				const redirect = isRedirectEndpoint(operation);
				issues.push({
					severity: redirect ? "info" : "warning",
					category: "operations",
					path: opPath,
					message: redirect
						? "Redirect endpoint — no 2xx response expected"
						: "No successful (2xx) response defined",
				});
			}
		}

		// Check: POST/PUT/PATCH should have requestBody
		if (method === "post" || method === "put" || method === "patch") {
			totalChecks++;
			if (!operation.requestBody) {
				const action = isActionEndpoint(method, operation);
				issues.push({
					severity: action ? "info" : "warning",
					category: "operations",
					path: opPath,
					message: action
						? `Action endpoint — ${method.toUpperCase()} without request body is expected`
						: `${method.toUpperCase()} without requestBody definition`,
				});
			}
		}
	});

	// Check: duplicate operationIds
	for (const [id, paths] of operationIdMap) {
		if (paths.length > 1) {
			totalChecks++;
			issues.push({
				severity: "error",
				category: "operations",
				path: paths.join(", "),
				message: `Duplicate operationId "${id}" used ${paths.length} times`,
			});
		}
	}

	return { issues, totalChecks };
}

function validateReferences(spec: unknown): CategoryResult {
	const issues: ValidationIssue[] = [];
	const refs: Array<{ ref: string; path: string }> = [];

	// Recursively collect all $ref strings
	const visited = new WeakSet<object>();

	function collectRefs(obj: unknown, currentPath: string): void {
		if (obj === null || obj === undefined || typeof obj !== "object") return;
		if (visited.has(obj as object)) return;
		visited.add(obj as object);

		if (Array.isArray(obj)) {
			for (let i = 0; i < obj.length; i++) {
				collectRefs(obj[i], `${currentPath}/${i}`);
			}
			return;
		}

		const record = obj as Record<string, unknown>;
		if (typeof record.$ref === "string") {
			refs.push({ ref: record.$ref, path: currentPath });
			return; // $ref objects don't have other meaningful children
		}

		for (const [key, value] of Object.entries(record)) {
			collectRefs(value, `${currentPath}/${key}`);
		}
	}

	collectRefs(spec, "");

	// Verify each $ref resolves
	for (const { ref, path } of refs) {
		const resolved = resolveRef(ref, spec);
		if (resolved === undefined) {
			issues.push({
				severity: "error",
				category: "references",
				path,
				message: `Unresolved $ref: ${ref}`,
			});
		}
	}

	return { issues, totalChecks: refs.length };
}

function validateParameters(spec: Record<string, unknown>): CategoryResult {
	const issues: ValidationIssue[] = [];
	let totalChecks = 0;

	forEachOperation(spec, (pathKey, method, operation) => {
		const opPath = `/paths${pathKey}/${method}`;

		// Extract path template params like {id}
		const templateParams = [...pathKey.matchAll(/\{([^}]+)\}/g)].map(
			(m) => m[1],
		);

		// Get operation parameters (resolve $refs on each)
		const rawParams = (operation.parameters ?? []) as Record<string, unknown>[];
		const params = rawParams.map((p) => resolveObject(p, spec));

		// Check: each parameter has name and in
		for (const param of params) {
			totalChecks++;
			if (!param.name || !param.in) {
				issues.push({
					severity: "error",
					category: "parameters",
					path: opPath,
					message: `Parameter missing required 'name' or 'in' field`,
				});
			}
		}

		// Check: path template params have matching parameter definitions
		for (const tmplParam of templateParams) {
			totalChecks++;
			const match = params.find(
				(p) => p.name === tmplParam && p.in === "path",
			);
			if (!match) {
				issues.push({
					severity: "warning",
					category: "parameters",
					path: opPath,
					message: `Path param {${tmplParam}} has no matching parameter definition`,
				});
			}
		}
	});

	return { issues, totalChecks };
}

function validateResponses(spec: Record<string, unknown>): CategoryResult {
	const issues: ValidationIssue[] = [];
	let totalChecks = 0;

	forEachOperation(spec, (pathKey, method, operation) => {
		const opPath = `/paths${pathKey}/${method}`;
		const responses = operation.responses as Record<string, unknown> | undefined;

		// Check: has at least one response
		totalChecks++;
		if (!responses || typeof responses !== "object" || Object.keys(responses).length === 0) {
			issues.push({
				severity: "warning",
				category: "responses",
				path: opPath,
				message: "No response status codes defined",
			});
			return;
		}

		// Check: 2xx responses have JSON content with schema
		const successCodes = Object.keys(responses).filter((c) => c.startsWith("2"));
		if (successCodes.length > 0) {
			totalChecks++;
			const hasJsonSchema = successCodes.some((code) => {
				const resp = resolveObject(
					responses[code] as Record<string, unknown>,
					spec,
				);
				const content = resp.content as Record<string, unknown> | undefined;
				const picked = pickJsonContent(content);
				return picked?.entry?.schema !== undefined;
			});

			if (!hasJsonSchema) {
				const streaming = isStreamingEndpoint(operation, spec);
				issues.push({
					severity: streaming ? "info" : "warning",
					category: "responses",
					path: opPath,
					message: streaming
						? "SSE endpoint — no JSON response schema expected"
						: "No 2xx response has a JSON-compatible schema — type generation will produce empty types",
				});
			}
		}
	});

	return { issues, totalChecks };
}

function validateTypeQuality(spec: Record<string, unknown>): CategoryResult {
	const issues: ValidationIssue[] = [];
	let totalChecks = 0;

	forEachOperation(spec, (pathKey, method, operation) => {
		const opPath = `/paths${pathKey}/${method}`;

		// Check response type quality
		const responses = operation.responses as Record<string, unknown> | undefined;
		if (responses) {
			const successCodes = Object.keys(responses).filter((c) => c.startsWith("2"));
			for (const code of successCodes) {
				const resp = resolveObject(
					responses[code] as Record<string, unknown>,
					spec,
				);
				const content = resp.content as Record<string, unknown> | undefined;
				const picked = pickJsonContent(content);
				const rawSchema = picked?.entry?.schema;

				if (!rawSchema) continue;

				totalChecks++;
				const resolved = resolveSchema(rawSchema, spec, 0, MAX_SCHEMA_DEPTH, new Set());

				if (!resolved) {
					issues.push({
						severity: "warning",
						category: "type-quality",
						path: `${opPath}/responses/${code}`,
						message: "Response schema could not be resolved — will generate as never",
					});
				} else if (resolved.type === "unknown") {
					issues.push({
						severity: "warning",
						category: "type-quality",
						path: `${opPath}/responses/${code}`,
						message: "Response schema has no type — will generate as never",
					});
				} else if (
					resolved.type === "object" &&
					(!resolved.properties || Object.keys(resolved.properties).length === 0) &&
					!resolved.oneOf &&
					!resolved.anyOf
				) {
					issues.push({
						severity: "info",
						category: "type-quality",
						path: `${opPath}/responses/${code}`,
						message: "Response object has 0 properties — may be a stub or placeholder",
					});
				} else if (resolved.type === "array" && !resolved.items) {
					issues.push({
						severity: "warning",
						category: "type-quality",
						path: `${opPath}/responses/${code}`,
						message: "Response array has no items schema — element type will be unknown",
					});
				}
			}
		}

		// Check request body type quality
		if (operation.requestBody) {
			const reqBody = resolveObject(
				operation.requestBody as Record<string, unknown>,
				spec,
			);
			const content = reqBody.content as Record<string, unknown> | undefined;
			if (content) {
				const picked = pickJsonContent(content);
				const formData = content["multipart/form-data"] as Record<string, unknown> | undefined;
				const bodyMedia = picked?.entry ?? formData;

				if (bodyMedia) {
					const rawSchema = bodyMedia.schema;
					totalChecks++;

					if (!rawSchema) {
						issues.push({
							severity: "warning",
							category: "type-quality",
							path: `${opPath}/requestBody`,
							message: "Request body has no schema — will generate as never",
						});
					} else {
						const resolved = resolveSchema(rawSchema, spec, 0, MAX_SCHEMA_DEPTH, new Set());
						if (!resolved || resolved.type === "unknown") {
							issues.push({
								severity: "warning",
								category: "type-quality",
								path: `${opPath}/requestBody`,
								message: "Request body schema has no type — will generate as never",
							});
						} else if (
							resolved.type === "object" &&
							(!resolved.properties || Object.keys(resolved.properties).length === 0) &&
							!resolved.oneOf &&
							!resolved.anyOf
						) {
							issues.push({
								severity: "info",
								category: "type-quality",
								path: `${opPath}/requestBody`,
								message: "Request body object has 0 properties — may be a stub or placeholder",
							});
						}
					}
				}
			}
		}
	});

	return { issues, totalChecks };
}

function validateSchemas(spec: Record<string, unknown>): CategoryResult {
	const issues: ValidationIssue[] = [];

	const components = spec.components as Record<string, unknown> | undefined;
	const schemas = components?.schemas as Record<string, unknown> | undefined;
	if (!schemas || typeof schemas !== "object") {
		return { issues, totalChecks: 0 };
	}

	const definedNames = new Set(Object.keys(schemas));

	// Collect all $ref targets that point to #/components/schemas/...
	const referencedNames = new Set<string>();
	const visited = new WeakSet<object>();

	function walkRefs(obj: unknown): void {
		if (obj === null || obj === undefined || typeof obj !== "object") return;
		if (visited.has(obj as object)) return;
		visited.add(obj as object);

		if (Array.isArray(obj)) {
			for (const item of obj) walkRefs(item);
			return;
		}

		const record = obj as Record<string, unknown>;
		if (typeof record.$ref === "string") {
			const match = record.$ref.match(/^#\/components\/schemas\/(.+)$/);
			if (match) referencedNames.add(match[1]);
			return;
		}

		for (const value of Object.values(record)) {
			walkRefs(value);
		}
	}

	walkRefs(spec);

	let totalChecks = 0;
	for (const name of definedNames) {
		totalChecks++;
		if (!referencedNames.has(name)) {
			issues.push({
				severity: "info",
				category: "schemas",
				path: `/components/schemas/${name}`,
				message: `Unused schema — defined but not referenced by any operation`,
			});
		}
	}

	return { issues, totalChecks };
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

export function validateSpec(spec: unknown): {
	issues: ValidationIssue[];
	categories: CategorySummary[];
} {
	const categories: CategorySummary[] = [];
	const allIssues: ValidationIssue[] = [];

	// Structure (always runs)
	const structure = validateStructure(spec);
	categories.push(buildSummary("structure", "Structure", structure));
	allIssues.push(...structure.issues);

	// If spec isn't a valid object, skip remaining checks
	if (typeof spec !== "object" || spec === null) {
		return { issues: allIssues, categories };
	}

	const specObj = spec as Record<string, unknown>;

	// Operations
	const operations = validateOperations(specObj);
	categories.push(buildSummary("operations", "Operations", operations));
	allIssues.push(...operations.issues);

	// References
	const references = validateReferences(spec);
	categories.push(buildSummary("references", "References", references));
	allIssues.push(...references.issues);

	// Parameters
	const parameters = validateParameters(specObj);
	categories.push(buildSummary("parameters", "Parameters", parameters));
	allIssues.push(...parameters.issues);

	// Responses
	const responses = validateResponses(specObj);
	categories.push(buildSummary("responses", "Responses", responses));
	allIssues.push(...responses.issues);

	// Type Quality
	const typeQuality = validateTypeQuality(specObj);
	categories.push(buildSummary("type-quality", "Type Quality", typeQuality));
	allIssues.push(...typeQuality.issues);

	// Schemas
	const schemas = validateSchemas(specObj);
	categories.push(buildSummary("schemas", "Schemas", schemas));
	allIssues.push(...schemas.issues);

	return { issues: allIssues, categories };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeValidate(
	options: ValidateActionOptions,
	logger: Logger,
): Promise<ValidateResult> {
	try {
		let specPath: string;

		if (options.specFile) {
			specPath = options.specFile;
		} else {
			const { config, projectRoot } = await loadConfig(options.configPath);
			const outputPaths = getOutputPaths(config, projectRoot);
			await ensureOutputFolder(outputPaths.folder);
			specPath = outputPaths.spec;
		}

		logger.debug({ specPath }, "spec path");

		const exists = await hasLocalSpec(specPath);
		if (!exists) {
			throw new SpecNotFoundError(specPath);
		}

		const { spec } = await loadLocalSpec(specPath);
		const { issues, categories } = validateSpec(spec);

		const errors = issues.filter((i) => i.severity === "error");
		const warnings = issues.filter((i) => i.severity === "warning");

		const valid = options.strict
			? errors.length + warnings.length === 0
			: errors.length === 0;

		return { issues, errors, warnings, valid, categories };
	} catch (error) {
		if (error instanceof SpecNotFoundError) {
			throw error;
		}

		logger.error(formatError(error));
		throw error;
	}
}
