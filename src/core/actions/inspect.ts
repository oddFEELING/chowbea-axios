/**
 * Inspect action - extracts full endpoint details from the cached OpenAPI spec.
 * Returns structured data for the Endpoint Inspector UI; does not print anything.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import { getOutputPaths, loadConfig } from "../config.js";
import { formatError } from "../errors.js";
import { hasLocalSpec, loadLocalSpec } from "../fetcher.js";
import {
	type SchemaDetail,
	MAX_SCHEMA_DEPTH,
	resolveObject,
	resolveSchema,
} from "../ref-utils.js";

export type { SchemaDetail };

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

/** HTTP methods to iterate when parsing paths. Shared with validate/diff/
 *  status so all 8 OpenAPI methods are visible. Issue #31. */
import { HTTP_METHODS } from "../http-methods.js";

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

	// Sort by path first, then by method for consistent ordering. Includes
	// trace so all 8 methods sort deterministically. Issue #31.
	const methodOrder: Record<string, number> = {
		get: 0,
		post: 1,
		put: 2,
		patch: 3,
		delete: 4,
		options: 5,
		head: 6,
		trace: 7,
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
