/**
 * Inspect action - extracts full endpoint details from the cached OpenAPI spec.
 * Returns structured data for the Endpoint Inspector UI; does not print anything.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import { getOutputPaths, loadConfig } from "../config.js";
import { formatError } from "../errors.js";
import { hasLocalSpec, loadLocalSpec } from "../fetcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaDetail {
	type: string;
	format?: string;
	description?: string;
	enum?: string[];
	required?: string[];
	properties?: Record<string, SchemaDetail>;
	items?: SchemaDetail;
	refName?: string;
	nullable?: boolean;
	default?: unknown;
	oneOf?: SchemaDetail[];
	anyOf?: SchemaDetail[];
	truncated?: boolean;
}

export interface ParameterDetail {
	name: string;
	in: "path" | "query" | "header" | "cookie";
	required: boolean;
	description: string;
	deprecated: boolean;
	schema: SchemaDetail | null;
}

export interface RequestBodyDetail {
	description: string;
	required: boolean;
	contentTypes: Array<{ mediaType: string; schema: SchemaDetail | null }>;
}

export interface ResponseDetail {
	statusCode: string;
	description: string;
	contentTypes: Array<{ mediaType: string; schema: SchemaDetail | null }>;
}

export interface EndpointDetail {
	operationId: string;
	method: string;
	path: string;
	summary: string;
	description: string;
	tags: string[];
	deprecated: boolean;
	parameters: ParameterDetail[];
	requestBody: RequestBodyDetail | null;
	responses: ResponseDetail[];
	security: Array<Record<string, string[]>>;
}

export interface InspectResult {
	endpoints: EndpointDetail[];
	specTitle: string;
	specVersion: string;
	openApiVersion: string;
	totalEndpoints: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InspectActionOptions {
	configPath?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default max depth for recursive schema resolution. */
const MAX_SCHEMA_DEPTH = 8;

/** HTTP methods to iterate when parsing paths. */
const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
] as const;

/**
 * Follows a `$ref` JSON pointer (e.g. `#/components/schemas/Foo`) through
 * the spec object and returns the resolved value.
 */
function resolveRef(ref: string, spec: unknown): unknown {
	if (typeof ref !== "string" || !ref.startsWith("#/")) {
		return undefined;
	}

	const segments = ref.slice(2).split("/");
	let current: unknown = spec;

	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Resolve a top-level `$ref` on an object (parameter, requestBody, response).
 * If the object has a `$ref` property, follow it and return the resolved object.
 * Otherwise return the object as-is.
 */
function resolveObject(
	obj: Record<string, unknown>,
	spec: unknown,
): Record<string, unknown> {
	if (typeof obj.$ref === "string") {
		const resolved = resolveRef(obj.$ref, spec);
		if (resolved && typeof resolved === "object") {
			return resolved as Record<string, unknown>;
		}
	}
	return obj;
}

/**
 * Extracts the last segment of a `$ref` path as a human-readable name.
 * e.g. `#/components/schemas/UserDto` -> `UserDto`
 */
function refName(ref: string): string {
	const segments = ref.split("/");
	return segments[segments.length - 1] ?? ref;
}

/**
 * Recursively resolves an OpenAPI schema into a `SchemaDetail`.
 *
 * Handles `$ref` pointers, circular references (via `visited` set),
 * `allOf` / `oneOf` / `anyOf` compositions, object properties, and array
 * items.  Truncates when `maxDepth` is reached.
 */
function resolveSchema(
	rawSchema: unknown,
	spec: unknown,
	depth: number,
	maxDepth: number,
	visited: Set<string>,
): SchemaDetail | null {
	if (rawSchema === null || rawSchema === undefined) {
		return null;
	}

	if (typeof rawSchema !== "object") {
		return null;
	}

	const schema = rawSchema as Record<string, unknown>;

	// --- $ref handling ---
	if (typeof schema.$ref === "string") {
		const name = refName(schema.$ref);

		// Circular reference guard
		if (visited.has(schema.$ref)) {
			return { type: "$ref", refName: name, truncated: true };
		}

		visited.add(schema.$ref);
		const resolved = resolveRef(schema.$ref, spec);

		if (resolved === undefined) {
			return { type: "$ref", refName: name, truncated: true };
		}

		const result = resolveSchema(resolved, spec, depth, maxDepth, visited);
		if (result) {
			result.refName = name;
		}
		return result;
	}

	// --- Depth guard ---
	if (depth >= maxDepth) {
		return { type: "...", truncated: true };
	}

	// --- Determine type (including OpenAPI 3.1 array-style nullable) ---
	let type: string = "unknown";
	let nullable = false;

	if (Array.isArray(schema.type)) {
		// OpenAPI 3.1: type: ["string", "null"]
		const types = schema.type as string[];
		nullable = types.includes("null");
		const nonNull = types.filter((t) => t !== "null");
		type = nonNull[0] ?? "unknown";
	} else if (typeof schema.type === "string") {
		type = schema.type;
	} else if (schema.oneOf || schema.anyOf || schema.allOf) {
		type = "composite";
	}

	// OpenAPI 3.0 nullable flag
	if (schema.nullable === true) {
		nullable = true;
	}

	const detail: SchemaDetail = { type };

	if (typeof schema.format === "string") detail.format = schema.format;
	if (typeof schema.description === "string") detail.description = schema.description;
	if (nullable) detail.nullable = true;
	if (schema.default !== undefined) detail.default = schema.default;

	if (Array.isArray(schema.enum)) {
		detail.enum = (schema.enum as unknown[]).map(String);
	}

	// --- Object properties ---
	if (type === "object" || schema.properties) {
		const props = schema.properties as Record<string, unknown> | undefined;
		if (props && typeof props === "object") {
			detail.type = "object";
			detail.properties = {};
			for (const [key, value] of Object.entries(props)) {
				const resolved = resolveSchema(value, spec, depth + 1, maxDepth, new Set(visited));
				if (resolved) {
					detail.properties[key] = resolved;
				}
			}
		}
		if (Array.isArray(schema.required)) {
			detail.required = (schema.required as unknown[]).filter(
				(r): r is string => typeof r === "string",
			);
		}
	}

	// --- Array items ---
	if (type === "array" || schema.items) {
		if (schema.items) {
			detail.type = "array";
			detail.items = resolveSchema(schema.items, spec, depth + 1, maxDepth, new Set(visited)) ?? undefined;
		}
	}

	// --- Composition keywords ---
	if (Array.isArray(schema.oneOf)) {
		detail.oneOf = (schema.oneOf as unknown[])
			.map((s) => resolveSchema(s, spec, depth + 1, maxDepth, new Set(visited)))
			.filter((s): s is SchemaDetail => s !== null);
	}

	if (Array.isArray(schema.anyOf)) {
		detail.anyOf = (schema.anyOf as unknown[])
			.map((s) => resolveSchema(s, spec, depth + 1, maxDepth, new Set(visited)))
			.filter((s): s is SchemaDetail => s !== null);
	}

	if (Array.isArray(schema.allOf)) {
		// Merge allOf schemas into a single object-like schema
		const mergedProps: Record<string, SchemaDetail> = {};
		const mergedRequired: string[] = [];

		for (const sub of schema.allOf as unknown[]) {
			const resolved = resolveSchema(sub, spec, depth + 1, maxDepth, new Set(visited));
			if (!resolved) continue;

			if (resolved.properties) {
				Object.assign(mergedProps, resolved.properties);
			}
			if (resolved.required) {
				mergedRequired.push(...resolved.required);
			}
			// Carry over description from allOf members if top-level is missing
			if (resolved.description && !detail.description) {
				detail.description = resolved.description;
			}
			// Carry over refName
			if (resolved.refName && !detail.refName) {
				detail.refName = resolved.refName;
			}
		}

		if (Object.keys(mergedProps).length > 0) {
			detail.type = "object";
			detail.properties = { ...detail.properties, ...mergedProps };
		}
		if (mergedRequired.length > 0) {
			detail.required = [
				...(detail.required ?? []),
				...mergedRequired,
			];
		}
	}

	return detail;
}

// ---------------------------------------------------------------------------
// Endpoint parsing
// ---------------------------------------------------------------------------

/**
 * Parses all endpoints from the OpenAPI spec's `paths` object.
 *
 * Merges path-level and operation-level parameters, resolves schemas for
 * parameters / request bodies / responses, and returns a sorted array of
 * `EndpointDetail` objects (sorted by path, then by method).
 */
function parseEndpoints(spec: unknown): EndpointDetail[] {
	if (typeof spec !== "object" || spec === null) {
		return [];
	}

	const specObj = spec as Record<string, unknown>;
	const paths = specObj.paths as Record<string, Record<string, unknown>> | undefined;

	if (!paths || typeof paths !== "object") {
		return [];
	}

	const endpoints: EndpointDetail[] = [];

	for (const [pathTemplate, pathItem] of Object.entries(paths)) {
		if (typeof pathItem !== "object" || pathItem === null) continue;

		// Path-level parameters (shared across all operations on this path)
		const pathParams = Array.isArray(pathItem.parameters)
			? (pathItem.parameters as Array<Record<string, unknown>>)
			: [];

		for (const method of HTTP_METHODS) {
			const operation = pathItem[method] as Record<string, unknown> | undefined;
			if (!operation) continue;

			// --- Merge parameters (operation overrides path by name+in) ---
			const operationParams = Array.isArray(operation.parameters)
				? (operation.parameters as Array<Record<string, unknown>>)
				: [];

			const paramMap = new Map<string, Record<string, unknown>>();

			for (const rawP of pathParams) {
				const p = resolveObject(rawP, spec);
				const key = `${String(p.name ?? "")}:${String(p.in ?? "")}`;
				paramMap.set(key, p);
			}
			for (const rawP of operationParams) {
				const p = resolveObject(rawP, spec);
				const key = `${String(p.name ?? "")}:${String(p.in ?? "")}`;
				paramMap.set(key, p);
			}

			const parameters: ParameterDetail[] = [...paramMap.values()].map(
				(p) => ({
					name: String(p.name ?? ""),
					in: (p.in as ParameterDetail["in"]) ?? "query",
					required: p.required === true,
					description: typeof p.description === "string" ? p.description : "",
					deprecated: p.deprecated === true,
					schema: resolveSchema(
						p.schema ?? null,
						spec,
						0,
						MAX_SCHEMA_DEPTH,
						new Set<string>(),
					),
				}),
			);

			// --- Operation ID (default to method_path if missing) ---
			const operationId =
				typeof operation.operationId === "string"
					? operation.operationId
					: `${method}_${pathTemplate.replace(/[{}\/]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;

			// --- Tags ---
			const tags = Array.isArray(operation.tags)
				? (operation.tags as unknown[]).filter((t): t is string => typeof t === "string")
				: [];

			// --- Request body ---
			let requestBody: RequestBodyDetail | null = null;

			if (operation.requestBody && typeof operation.requestBody === "object") {
				const rb = resolveObject(
					operation.requestBody as Record<string, unknown>,
					spec,
				);
				const contentTypes: RequestBodyDetail["contentTypes"] = [];

				const content = rb.content as Record<string, Record<string, unknown>> | undefined;
				if (content && typeof content === "object") {
					for (const [mediaType, mediaTypeObj] of Object.entries(content)) {
						contentTypes.push({
							mediaType,
							schema: resolveSchema(
								mediaTypeObj?.schema ?? null,
								spec,
								0,
								MAX_SCHEMA_DEPTH,
								new Set<string>(),
							),
						});
					}
				}

				requestBody = {
					description: typeof rb.description === "string" ? rb.description : "",
					required: rb.required === true,
					contentTypes,
				};
			}

			// --- Responses ---
			const responses: ResponseDetail[] = [];

			if (operation.responses && typeof operation.responses === "object") {
				const responsesObj = operation.responses as Record<string, Record<string, unknown>>;

				for (const [statusCode, rawResponseObj] of Object.entries(responsesObj)) {
					if (typeof rawResponseObj !== "object" || rawResponseObj === null) continue;
					const responseObj = resolveObject(
						rawResponseObj as Record<string, unknown>,
						spec,
					);

					const contentTypes: ResponseDetail["contentTypes"] = [];

					const content = responseObj.content as
						| Record<string, Record<string, unknown>>
						| undefined;
					if (content && typeof content === "object") {
						for (const [mediaType, mediaTypeObj] of Object.entries(content)) {
							contentTypes.push({
								mediaType,
								schema: resolveSchema(
									mediaTypeObj?.schema ?? null,
									spec,
									0,
									MAX_SCHEMA_DEPTH,
									new Set<string>(),
								),
							});
						}
					}

					responses.push({
						statusCode,
						description:
							typeof responseObj.description === "string"
								? responseObj.description
								: "",
						contentTypes,
					});
				}
			}

			// --- Security ---
			const security = Array.isArray(operation.security)
				? (operation.security as Array<Record<string, string[]>>)
				: [];

			endpoints.push({
				operationId,
				method,
				path: pathTemplate,
				summary: typeof operation.summary === "string" ? operation.summary : "",
				description:
					typeof operation.description === "string" ? operation.description : "",
				tags,
				deprecated: operation.deprecated === true,
				parameters,
				requestBody,
				responses,
				security,
			});
		}
	}

	// Sort by path first, then by method for consistent ordering
	const methodOrder: Record<string, number> = {
		get: 0,
		post: 1,
		put: 2,
		patch: 3,
		delete: 4,
		options: 5,
		head: 6,
	};

	endpoints.sort((a, b) => {
		const pathCmp = a.path.localeCompare(b.path);
		if (pathCmp !== 0) return pathCmp;
		return (methodOrder[a.method] ?? 99) - (methodOrder[b.method] ?? 99);
	});

	return endpoints;
}

// ---------------------------------------------------------------------------
// Public action
// ---------------------------------------------------------------------------

/**
 * Executes the inspect action: loads the cached OpenAPI spec and extracts
 * full endpoint details including parameters, request bodies, responses,
 * and resolved schemas.
 *
 * Returns structured data without any UI rendering.
 */
export async function executeInspect(
	options: InspectActionOptions,
	logger: Logger,
): Promise<InspectResult> {
	try {
		// Load configuration
		const { config, projectRoot } = await loadConfig(options.configPath);

		// Get output paths
		const outputPaths = getOutputPaths(config, projectRoot);

		// Check that a local spec exists
		const specExists = await hasLocalSpec(outputPaths.spec);
		if (!specExists) {
			throw new Error(
				`No local OpenAPI spec found at ${outputPaths.spec}. ` +
					"Run a fetch first to download and cache the spec.",
			);
		}

		// Load and parse the spec
		const { spec } = await loadLocalSpec(outputPaths.spec);

		// Extract spec metadata
		const specObj = spec as Record<string, unknown>;
		const info = (specObj.info ?? {}) as Record<string, unknown>;

		const specTitle = typeof info.title === "string" ? info.title : "Untitled";
		const specVersion = typeof info.version === "string" ? info.version : "0.0.0";
		const openApiVersion =
			typeof specObj.openapi === "string"
				? specObj.openapi
				: typeof specObj.swagger === "string"
					? specObj.swagger
					: "unknown";

		// Parse endpoints
		const endpoints = parseEndpoints(spec);

		return {
			endpoints,
			specTitle,
			specVersion,
			openApiVersion,
			totalEndpoints: endpoints.length,
		};
	} catch (error) {
		logger.error(formatError(error));
		throw error;
	}
}
