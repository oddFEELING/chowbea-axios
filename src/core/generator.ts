/**
 * Core generation logic for TypeScript types and operations.
 * Migrated from scripts/generate-operations.js with atomic writes and rollback.
 */

import { spawnSync } from "node:child_process";
import {
	access,
	copyFile,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { findProjectRoot } from "./config.js";
import type { InstanceConfig, OutputPaths } from "./config.js";
import { GenerationError } from "./errors.js";
import type { Logger } from "../adapters/logger-interface.js";
import { detectPackageManager, getDlxCommand } from "./pm.js";

/**
 * Output paths for generated files.
 * Re-export OutputPaths from config for backwards compatibility.
 */
export type GeneratorPaths = OutputPaths;

/**
 * Result of client files generation.
 */
export interface ClientFilesResult {
	/** Whether api.helpers.ts was generated */
	helpers: boolean;
	/** Whether api.instance.ts was generated */
	instance: boolean;
	/** Whether api.error.ts was generated */
	error: boolean;
	/** Whether api.client.ts was generated */
	client: boolean;
}

/**
 * Result of the generation process.
 */
export interface GenerationResult {
	/** Number of operations generated */
	operationCount: number;
	/** Duration of generation in milliseconds */
	durationMs: number;
	/** Whether types were generated successfully */
	typesGenerated: boolean;
	/** Whether operations were generated successfully */
	operationsGenerated: boolean;
	/** Whether contracts were generated successfully */
	contractsGenerated: boolean;
	/** Client files generated (if any) */
	clientFiles?: ClientFilesResult;
}

/**
 * Extracts path parameter names from an OpenAPI path template.
 * Example: "/api/users/{id}/posts/{postId}" -> ["id", "postId"]
 */
function extractPathParams(pathTemplate: string): string[] {
	const matches = pathTemplate.matchAll(/\{([^}]+)\}/g);
	return [...matches].map((match) => match[1]);
}

/**
 * OpenAPI operation metadata extracted from spec.
 */
interface OperationMetadata {
	operationId: string;
	method: string;
	path: string;
	pathParams: string[];
	hasRequestBody: boolean;
	hasQueryParams: boolean;
	hasJsonBody: boolean;
	hasFormDataBody: boolean;
	responseStatus: number | null;
	summary: string;
	description: string;
}

/**
 * Generates a single operation function.
 */
function generateOperationFunction(operation: OperationMetadata): string {
	const {
		operationId,
		method,
		path: pathTemplate,
		pathParams,
		hasRequestBody,
		hasQueryParams,
		hasJsonBody,
		hasFormDataBody,
		responseStatus,
		summary,
		description,
	} = operation;

	const httpMethod = method.toLowerCase();
	const contractBase = toPascalCase(sanitizeIdentifier(operationId));

	// Build parameter list
	const params: string[] = [];

	// Path parameters — named contract from api.contracts.ts
	if (pathParams.length > 0) {
		params.push(`pathParams: ${contractBase}PathParams`);
	}

	// Request body for POST/PUT/PATCH — form-data bodies are wrapped in
	// MapFormDataTypes because api.contracts.ts emits the raw OpenAPI schema
	// without mapping file-like fields to `File | Blob`.
	if (hasRequestBody) {
		const bodyType = hasFormDataBody && !hasJsonBody
			? `MapFormDataTypes<${contractBase}Body>`
			: `${contractBase}Body`;
		params.push(`data: ${bodyType}`);
	}

	// Config parameter (always last and optional)
	const configType = hasQueryParams
		? `RequestConfig<${contractBase}QueryParams>`
		: `AxiosRequestConfig`;
	params.push(`config?: ${configType}`);

	// Generate JSDoc comment
	const jsdoc: string[] = [];
	jsdoc.push("  /**");
	if (summary) {
		jsdoc.push(`   * ${summary}`);
	}
	if (description && description !== summary) {
		jsdoc.push(`   * ${description}`);
	}
	jsdoc.push("   * ");
	jsdoc.push(`   * @operationId ${operationId}`);
	jsdoc.push(`   * @method ${method.toUpperCase()}`);
	jsdoc.push(`   * @path ${pathTemplate}`);
	jsdoc.push("   */");

	// Generate function with explicit return type - uses Result<T> for consistent error handling.
	// Named response contract is only emitted when a 2xx JSON response exists; otherwise fall back to unknown.
	const functionParams = params.join(", ");
	const responseType = responseStatus !== null ? `${contractBase}Response` : `unknown`;
	const returnType = `Promise<Result<${responseType}>>`;

	// Build the apiClient call (apiClient methods already return Result<T>)
	let apiCall: string;
	if (hasRequestBody) {
		// POST/PUT/PATCH with body
		if (pathParams.length > 0) {
			apiCall = `apiClient.${httpMethod}("${pathTemplate}", data, pathParams, config)`;
		} else {
			apiCall = `apiClient.${httpMethod}("${pathTemplate}", data, config)`;
		}
	} else {
		// GET/DELETE without body
		// PATCH without body still needs undefined as data parameter
		if (httpMethod === "patch") {
			if (pathParams.length > 0) {
				apiCall = `apiClient.${httpMethod}("${pathTemplate}", undefined, pathParams, config)`;
			} else {
				apiCall = `apiClient.${httpMethod}("${pathTemplate}", undefined, config)`;
			}
		} else if (pathParams.length > 0) {
			apiCall = `apiClient.${httpMethod}("${pathTemplate}", pathParams, config)`;
		} else {
			apiCall = `apiClient.${httpMethod}("${pathTemplate}", config)`;
		}
	}

	return `${jsdoc.join("\n")}
  ${operationId}: (${functionParams}): ${returnType} => ${apiCall},\n`;
}

/**
 * Parses the OpenAPI spec and extracts all operations with operationIds.
 */
function parseOperations(spec: unknown, logger: Logger): OperationMetadata[] {
	const operations: OperationMetadata[] = [];

	if (typeof spec !== "object" || spec === null) {
		return operations;
	}

	const specObj = spec as Record<string, unknown>;
	const paths = specObj.paths as
		| Record<string, Record<string, unknown>>
		| undefined;

	if (!paths) {
		return operations;
	}

	// Iterate through all paths
	for (const [pathTemplate, pathItem] of Object.entries(paths)) {
		// Iterate through all HTTP methods
		for (const method of ["get", "post", "put", "delete", "patch"]) {
			const operation = pathItem[method] as Record<string, unknown> | undefined;

			if (!operation) continue;

			// Skip operations without operationId
			if (!operation.operationId || typeof operation.operationId !== "string") {
				logger.warn(
					{ method: method.toUpperCase(), path: pathTemplate },
					"Skipping operation without operationId"
				);
				continue;
			}

			// Extract path parameters
			const pathParams = extractPathParams(pathTemplate);

			// Check for request body content types
			const requestBody = operation.requestBody as
				| Record<string, unknown>
				| undefined;
			const hasRequestBody = Boolean(requestBody);
			let hasJsonBody = false;
			let hasFormDataBody = false;
			if (requestBody) {
				const content = requestBody.content as
					| Record<string, unknown>
					| undefined;
				if (content) {
					if (content["application/json"]) hasJsonBody = true;
					if (content["multipart/form-data"]) hasFormDataBody = true;
				}
			}

			// Check for query parameters
			const parameters = operation.parameters as
				| Array<{ in?: string }>
				| undefined;
			const hasQueryParams =
				parameters?.some((param) => param.in === "query") ?? false;

			// Determine primary success response status (first 2xx with JSON content).
			// Drives whether a named `${Base}Response` contract exists to import.
			let responseStatus: number | null = null;
			const responses = operation.responses as
				| Record<string, unknown>
				| undefined;
			if (responses) {
				for (const [statusKey, responseObj] of Object.entries(responses)) {
					const statusNum = parseInt(statusKey, 10);
					if (isNaN(statusNum)) continue;
					if (statusNum < 200 || statusNum >= 300) continue;
					const resp = responseObj as Record<string, unknown>;
					const content = resp.content as
						| Record<string, unknown>
						| undefined;
					if (content && content["application/json"]) {
						responseStatus = statusNum;
						break;
					}
				}
			}

			operations.push({
				operationId: operation.operationId,
				method,
				path: pathTemplate,
				pathParams,
				hasRequestBody,
				hasQueryParams,
				hasJsonBody,
				hasFormDataBody,
				responseStatus,
				summary: (operation.summary as string) ?? "",
				description: (operation.description as string) ?? "",
			});

			logger.debug({ operationId: operation.operationId }, "Found operation");
		}
	}

	return operations;
}

/**
 * Contract metadata for generating concrete type aliases.
 */
interface ContractResponseMeta {
	status: number;
	description: string;
	hasJsonContent: boolean;
}

interface ContractOperationMeta {
	operationId: string;
	method: string;
	path: string;
	/** Primary success status (first 2xx with JSON content), kept for backwards compat */
	responseStatus: number | null;
	/** All response statuses defined in the spec */
	allResponses: ContractResponseMeta[];
	hasJsonBody: boolean;
	hasFormDataBody: boolean;
	hasPathParams: boolean;
	hasQueryParams: boolean;
}

interface ContractMetadata {
	schemas: Record<string, unknown>;
	operations: ContractOperationMeta[];
	/** Full spec for resolving response/request body schemas inline */
	spec: Record<string, unknown>;
}

/**
 * Parses the OpenAPI spec and extracts metadata needed for concrete type contracts.
 * Extracts schema names, operation responses, request bodies, path params, and query params.
 */
function parseContracts(spec: unknown): ContractMetadata {
	const result: ContractMetadata = { schemas: {}, operations: [], spec: {} };

	if (typeof spec !== "object" || spec === null) return result;

	const specObj = spec as Record<string, unknown>;
	result.spec = specObj;

	// Extract all schemas from components.schemas
	const components = specObj.components as Record<string, unknown> | undefined;
	if (components && typeof components === "object") {
		const schemas = components.schemas as Record<string, unknown> | undefined;
		if (schemas && typeof schemas === "object") {
			result.schemas = schemas;
		}
	}

	// Extract operation metadata from paths
	const paths = specObj.paths as Record<string, Record<string, unknown>> | undefined;
	if (!paths) return result;

	for (const [pathTemplate, pathItem] of Object.entries(paths)) {
		for (const method of ["get", "post", "put", "delete", "patch"]) {
			const operation = pathItem[method] as Record<string, unknown> | undefined;
			if (!operation) continue;
			if (!operation.operationId || typeof operation.operationId !== "string") continue;

			// Collect all response statuses and determine the primary success status
			let responseStatus: number | null = null;
			const allResponses: ContractResponseMeta[] = [];
			const responses = operation.responses as Record<string, unknown> | undefined;
			if (responses) {
				for (const [statusKey, responseObj] of Object.entries(responses)) {
					const statusNum = parseInt(statusKey, 10);
					if (isNaN(statusNum)) continue;
					const resp = responseObj as Record<string, unknown>;
					const content = resp.content as Record<string, unknown> | undefined;
					const hasJsonContent = !!(content && content["application/json"]);
					const description = typeof resp.description === "string" ? resp.description : "";
					allResponses.push({ status: statusNum, description, hasJsonContent });

					// First 2xx with JSON content is the primary success status
					if (responseStatus === null && statusNum >= 200 && statusNum < 300 && hasJsonContent) {
						responseStatus = statusNum;
					}
				}
				// Sort by status code for consistent output
				allResponses.sort((a, b) => a.status - b.status);
			}

			// Check for request body content types
			let hasJsonBody = false;
			let hasFormDataBody = false;
			const requestBody = operation.requestBody as Record<string, unknown> | undefined;
			if (requestBody) {
				const content = requestBody.content as Record<string, unknown> | undefined;
				if (content) {
					if (content["application/json"]) hasJsonBody = true;
					if (content["multipart/form-data"]) hasFormDataBody = true;
				}
			}

			// Check for path and query parameters
			let hasPathParams = false;
			let hasQueryParams = false;
			const parameters = operation.parameters as Array<{ in?: string }> | undefined;
			if (parameters) {
				hasPathParams = parameters.some((p) => p.in === "path");
				hasQueryParams = parameters.some((p) => p.in === "query");
			}

			result.operations.push({
				operationId: operation.operationId,
				method,
				path: pathTemplate,
				responseStatus,
				allResponses,
				hasJsonBody,
				hasFormDataBody,
				hasPathParams,
				hasQueryParams,
			});
		}
	}

	return result;
}

/**
 * Generates the TypeScript file content with all operations.
 */
function generateOperationsFileContent(
	operations: OperationMetadata[]
): string {
	// Collect the set of named contract types each operation references.
	// Each entry must be gated on the same condition the contracts file uses
	// to emit the corresponding type, or the import will dangle.
	const contractNames = new Set<string>();
	for (const op of operations) {
		const base = toPascalCase(sanitizeIdentifier(op.operationId));
		if (op.responseStatus !== null) contractNames.add(`${base}Response`);
		if (op.hasJsonBody || op.hasFormDataBody) contractNames.add(`${base}Body`);
		if (op.pathParams.length > 0) contractNames.add(`${base}PathParams`);
		if (op.hasQueryParams) contractNames.add(`${base}QueryParams`);
	}
	const contractImport =
		contractNames.size > 0
			? `import type {\n  ${[...contractNames].sort().join(",\n  ")},\n} from "./api.contracts"`
			: "";

	const header = `/**
 * Auto-generated API operations from OpenAPI spec.
 *
 * This file is automatically generated by chowbea-axios CLI.
 * DO NOT EDIT MANUALLY - your changes will be overwritten.
 *
 * Total operations: ${operations.length}
 */

/* ~ =================================== ~ */
/* -- This file provides semantic operation-based API functions -- */
/* -- Use apiClient.op.operationName() instead of raw paths -- */
/* ~ =================================== ~ */

import type { AxiosRequestConfig } from "axios"
import type { Result } from "../api.error"
${contractImport}

/* ~ =================================== ~ */
/* -- Type Helpers -- */
/* ~ =================================== ~ */

/**
 * Maps OpenAPI form-data field types to their runtime equivalents.
 * Uses field names to intelligently detect file upload fields vs regular string fields.
 *
 * File field patterns: images, files, attachments, uploads, documents, photos, videos, media
 * Regular string fields: All other string/string[] fields remain unchanged
 */
type MapFormDataTypes<T> = T extends Record<string, unknown>
  ? {
      [K in keyof T]:
        // Check if field name suggests it's a file upload field
        K extends \`\${string}image\${string}\` | \`\${string}file\${string}\` | \`\${string}attachment\${string}\` |
                   \`\${string}upload\${string}\` | \`\${string}document\${string}\` | \`\${string}photo\${string}\` |
                   \`\${string}video\${string}\` | \`\${string}media\${string}\`
          ? T[K] extends string[]
            ? File[]  // File upload fields become File[]
            : T[K] extends string
              ? File | Blob  // Single file becomes File or Blob
              : T[K]
          : T[K];  // Non-file fields keep their original type
    }
  : T;

/**
 * Axios request config with typed query parameters for operations that accept them.
 * The type parameter Q is the operation-specific QueryParams contract from api.contracts.
 */
type RequestConfig<Q> = Omit<AxiosRequestConfig, "params"> & {
  params?: Q
}

/* ~ =================================== ~ */
/* -- Generated Operations -- */
/* ~ =================================== ~ */

/**
 * Collection of all API operations extracted from the OpenAPI spec.
 * Each operation is a typed function that wraps the underlying apiClient methods.
 * 
 * @example
 * \`\`\`typescript
 * // Using operation-based API
 * await apiClient.op.getUserById({ id: "123" })
 * 
 * // With query parameters
 * await apiClient.op.listUsers({ params: { limit: 10, offset: 0 } })
 * 
 * // With request body
 * await apiClient.op.createUser({ name: "John", email: "john@example.com" })
 * \`\`\`
 */
export const createOperations = (apiClient: any) => ({
`;

	const operationFunctions = operations
		.map((op) => generateOperationFunction(op))
		.join("\n");

	const footer = `}) as const

/**
 * Type representing all available API operations.
 * This type is inferred from the createOperations return value for proper TypeScript support.
 */
export type ApiOperations = ReturnType<typeof createOperations>
`;

	return header + operationFunctions + footer;
}

/**
 * Sanitizes a string to be a valid TypeScript identifier.
 * Replaces dots, hyphens, spaces, etc. with underscores. Ensures it doesn't start with a digit.
 */
function sanitizeIdentifier(name: string): string {
	let sanitized = name.replace(/[^a-zA-Z0-9_$]/g, "_");
	if (/^[0-9]/.test(sanitized)) {
		sanitized = `_${sanitized}`;
	}
	return sanitized;
}

/**
 * Formats a property name for use as an object-type key. Preserves the original
 * name when it's a valid unquoted TS identifier; otherwise wraps it in quotes so
 * names like `hub.mode`, `X-Custom-Header`, or `0.5` remain syntactically valid.
 */
function formatPropertyKey(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Capitalizes the first letter of a string (for PascalCase conversion from camelCase operationIds).
 */
function toPascalCase(str: string): string {
	if (str.length === 0) return str;
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Resolves a $ref string like "#/components/schemas/UserContract" to the schema name.
 */
function resolveRefName(ref: string): string | null {
	const prefix = "#/components/schemas/";
	if (ref.startsWith(prefix)) {
		return ref.slice(prefix.length);
	}
	return null;
}

/**
 * Converts a JSON Schema to a fully-expanded TypeScript type string.
 * Recursively inlines $ref schemas so every type is visible without indirection.
 * Uses a visited set to detect circular references (falls back to `unknown` for cycles).
 */
function schemaToTS(
	schema: Record<string, unknown>,
	indent: string,
	allSchemas: Record<string, unknown>,
	visited: Set<string> = new Set(),
): string {
	if (!schema || typeof schema !== "object") return "unknown";

	// $ref → recursively inline the referenced schema
	if (schema.$ref && typeof schema.$ref === "string") {
		const refName = resolveRefName(schema.$ref);
		if (!refName) return "unknown";
		if (visited.has(refName)) return "unknown"; // circular ref guard
		const refSchema = allSchemas[refName] as Record<string, unknown> | undefined;
		if (!refSchema) return "unknown";
		const newVisited = new Set(visited);
		newVisited.add(refName);
		return schemaToTS(refSchema, indent, allSchemas, newVisited);
	}

	// allOf → intersection
	if (Array.isArray(schema.allOf)) {
		const parts = (schema.allOf as Record<string, unknown>[]).map((s) => schemaToTS(s, indent, allSchemas, visited));
		return parts.join(" & ") || "unknown";
	}

	// oneOf / anyOf → union
	const unionKey = schema.oneOf ? "oneOf" : schema.anyOf ? "anyOf" : null;
	if (unionKey && Array.isArray(schema[unionKey])) {
		const parts = (schema[unionKey] as Record<string, unknown>[]).map((s) => schemaToTS(s, indent, allSchemas, visited));
		return parts.join(" | ") || "unknown";
	}

	// enum
	if (Array.isArray(schema.enum)) {
		return schema.enum.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ");
	}

	const schemaType = schema.type as string | string[] | undefined;

	// array
	if (schemaType === "array") {
		const items = schema.items as Record<string, unknown> | undefined;
		const itemType = items ? schemaToTS(items, indent, allSchemas, visited) : "unknown";
		// Wrap union/intersection array item types in parens for correctness
		const needsParens = itemType.includes(" | ") || itemType.includes(" & ");
		return needsParens ? `(${itemType})[]` : `${itemType}[]`;
	}

	// object with properties → inline object type
	if (schemaType === "object" || schema.properties) {
		const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
		if (!properties || Object.keys(properties).length === 0) {
			return "Record<string, unknown>";
		}
		const required = new Set<string>(Array.isArray(schema.required) ? schema.required as string[] : []);
		const innerIndent = indent + "\t";
		const props = Object.entries(properties).map(([key, propSchema]) => {
			const optional = required.has(key) ? "" : "?";
			const propType = schemaToTS(propSchema, innerIndent, allSchemas, visited);
			const desc = propSchema.description ? ` /** ${propSchema.description} */\n${innerIndent}` : "";
			return `${desc}${formatPropertyKey(key)}${optional}: ${propType};`;
		});
		return `{\n${innerIndent}${props.join(`\n${innerIndent}`)}\n${indent}}`;
	}

	// primitive types
	if (schemaType === "string") return schema.format === "binary" ? "File | Blob" : "string";
	if (schemaType === "number" || schemaType === "integer") return "number";
	if (schemaType === "boolean") return "boolean";
	if (schemaType === "null") return "null";

	// nullable shorthand
	if (schema.nullable === true) {
		const inner = { ...schema, nullable: undefined };
		return `${schemaToTS(inner, indent, allSchemas, visited)} | null`;
	}

	return "unknown";
}

/**
 * Resolves an operation's response/request body/params schema from the spec.
 */
function resolveOperationSchema(
	spec: Record<string, unknown>,
	operationId: string,
	kind: "response" | "requestBody" | "pathParams" | "queryParams",
	responseStatus?: number,
	contentType?: string,
): Record<string, unknown> | null {
	const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
	if (!paths) return null;

	for (const pathItem of Object.values(paths)) {
		for (const method of ["get", "post", "put", "delete", "patch"]) {
			const op = pathItem[method] as Record<string, unknown> | undefined;
			if (!op || op.operationId !== operationId) continue;

			if (kind === "response" && responseStatus != null) {
				const responses = op.responses as Record<string, Record<string, unknown>> | undefined;
				const resp = responses?.[String(responseStatus)];
				const content = resp?.content as Record<string, Record<string, unknown>> | undefined;
				return (content?.["application/json"]?.schema as Record<string, unknown>) ?? null;
			}

			if (kind === "requestBody") {
				const rb = op.requestBody as Record<string, unknown> | undefined;
				const content = rb?.content as Record<string, Record<string, unknown>> | undefined;
				const ct = contentType ?? "application/json";
				return (content?.[ct]?.schema as Record<string, unknown>) ?? null;
			}

			if (kind === "pathParams" || kind === "queryParams") {
				const paramKind = kind === "pathParams" ? "path" : "query";
				const parameters = op.parameters as Array<Record<string, unknown>> | undefined;
				if (!parameters) return null;
				const filtered = parameters.filter((p) => p.in === paramKind);
				if (filtered.length === 0) return null;
				// Build a synthetic object schema from params
				const required: string[] = [];
				const properties: Record<string, unknown> = {};
				for (const param of filtered) {
					const name = param.name as string;
					properties[name] = param.schema ?? { type: "string" };
					if (param.required) required.push(name);
					// Attach description from param to schema
					if (param.description && typeof param.schema === "object" && param.schema !== null) {
						(properties[name] as Record<string, unknown>).description = param.description;
					}
				}
				return { type: "object", properties, required };
			}
		}
	}
	return null;
}

/**
 * Generates the api.contracts.ts file content.
 * Contains concrete interfaces for every schema, operation response,
 * request body, path param, and query param — enabling cmd+click navigation
 * to see real type fields.
 */
function generateContractsFileContent(metadata: ContractMetadata): string {
	const lines: string[] = [];
	const allSchemas = metadata.schemas as Record<string, unknown>;

	lines.push(`/**
 * Concrete type contracts extracted from OpenAPI spec.
 *
 * Auto-generated by chowbea-axios CLI.
 * DO NOT EDIT MANUALLY - changes will be overwritten.
 *
 * Every type is fully expanded inline — no indirection, no generic references.
 * Cmd+click any type to see its full structure right here.
 */
`);

	// ~ ======= Schema Models ======= ~
	const schemaEntries = Object.entries(metadata.schemas);
	if (schemaEntries.length > 0) {
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(`/* -- Schema Models -- */`);
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(``);

		for (const [name, schema] of schemaEntries) {
			const typeName = sanitizeIdentifier(name);
			const schemaObj = schema as Record<string, unknown>;
			const desc = schemaObj.description ? ` * ${schemaObj.description}\n ` : "";
			lines.push(`/**\n ${desc}* Schema: ${name}\n */`);

			// For object schemas, emit an interface; for others, emit a type alias
			if (schemaObj.type === "object" || schemaObj.properties) {
				const properties = schemaObj.properties as Record<string, Record<string, unknown>> | undefined;
				if (properties && Object.keys(properties).length > 0) {
					const required = new Set<string>(Array.isArray(schemaObj.required) ? schemaObj.required as string[] : []);
					lines.push(`export interface ${typeName} {`);
					for (const [propKey, propSchema] of Object.entries(properties)) {
						const optional = required.has(propKey) ? "" : "?";
						const propType = schemaToTS(propSchema, "\t", allSchemas);
						if (propSchema.description) {
							lines.push(`\t/** ${propSchema.description} */`);
						}
						lines.push(`\t${formatPropertyKey(propKey)}${optional}: ${propType};`);
					}
					lines.push(`}`);
				} else {
					lines.push(`export type ${typeName} = Record<string, unknown>;`);
				}
			} else {
				const tsType = schemaToTS(schemaObj, "", allSchemas);
				lines.push(`export type ${typeName} = ${tsType};`);
			}
			lines.push(``);
		}
	}

	// ~ ======= Operation Responses ======= ~
	const opsWithResponses = metadata.operations.filter((op) => op.allResponses.length > 0);
	if (opsWithResponses.length > 0) {
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(`/* -- Operation Responses -- */`);
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(``);

		for (const op of opsWithResponses) {
			const baseName = toPascalCase(sanitizeIdentifier(op.operationId));

			// Emit per-status types for every response that has JSON content
			const statusTypes: string[] = [];
			for (const resp of op.allResponses) {
				if (!resp.hasJsonContent) continue;
				const statusTypeName = `${baseName}Response${resp.status}`;
				const desc = resp.description ? ` - ${resp.description}` : "";
				const schema = resolveOperationSchema(metadata.spec, op.operationId, "response", resp.status);
				lines.push(`/** Response: ${op.method.toUpperCase()} ${op.path} (${resp.status}${desc}) */`);
				if (schema) {
					lines.push(`export type ${statusTypeName} = ${schemaToTS(schema, "", allSchemas)};`);
				} else {
					lines.push(`export type ${statusTypeName} = unknown;`);
				}
				lines.push(``);
				statusTypes.push(statusTypeName);
			}

			// Emit statusless alias pointing to the primary success response
			if (op.responseStatus !== null) {
				const successTypeName = `${baseName}Response${op.responseStatus}`;
				lines.push(`/** Response: ${op.method.toUpperCase()} ${op.path} (happy path) */`);
				lines.push(`export type ${baseName}Response = ${successTypeName};`);
				lines.push(``);
			}
		}
	}

	// ~ ======= Operation Request Bodies ======= ~
	const bodyOps = metadata.operations.filter((op) => op.hasJsonBody || op.hasFormDataBody);
	if (bodyOps.length > 0) {
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(`/* -- Operation Request Bodies -- */`);
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(``);

		for (const op of bodyOps) {
			const typeName = `${toPascalCase(sanitizeIdentifier(op.operationId))}Body`;
			const contentType = op.hasJsonBody ? "application/json" : "multipart/form-data";
			const schema = resolveOperationSchema(metadata.spec, op.operationId, "requestBody", undefined, contentType);
			lines.push(`/** Request body: ${op.method.toUpperCase()} ${op.path} */`);
			if (schema) {
				lines.push(`export type ${typeName} = ${schemaToTS(schema, "", allSchemas)};`);
			} else {
				lines.push(`export type ${typeName} = unknown;`);
			}
			lines.push(``);
		}
	}

	// ~ ======= Operation Path Parameters ======= ~
	const pathParamOps = metadata.operations.filter((op) => op.hasPathParams);
	if (pathParamOps.length > 0) {
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(`/* -- Operation Path Parameters -- */`);
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(``);

		for (const op of pathParamOps) {
			const typeName = `${toPascalCase(sanitizeIdentifier(op.operationId))}PathParams`;
			const schema = resolveOperationSchema(metadata.spec, op.operationId, "pathParams");
			lines.push(`/** Path params: ${op.method.toUpperCase()} ${op.path} */`);
			if (schema) {
				lines.push(`export type ${typeName} = ${schemaToTS(schema, "", allSchemas)};`);
			} else {
				lines.push(`export type ${typeName} = Record<string, string>;`);
			}
			lines.push(``);
		}
	}

	// ~ ======= Operation Query Parameters ======= ~
	const queryParamOps = metadata.operations.filter((op) => op.hasQueryParams);
	if (queryParamOps.length > 0) {
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(`/* -- Operation Query Parameters -- */`);
		lines.push(`/* ~ =================================== ~ */`);
		lines.push(``);

		for (const op of queryParamOps) {
			const typeName = `${toPascalCase(sanitizeIdentifier(op.operationId))}QueryParams`;
			const schema = resolveOperationSchema(metadata.spec, op.operationId, "queryParams");
			lines.push(`/** Query params: ${op.method.toUpperCase()} ${op.path} */`);
			if (schema) {
				lines.push(`export type ${typeName} = ${schemaToTS(schema, "", allSchemas)};`);
			} else {
				lines.push(`export type ${typeName} = Record<string, unknown>;`);
			}
			lines.push(``);
		}
	}

	return lines.join("\n");
}

/**
 * Runs openapi-typescript to generate base types.
 * Uses the detected package manager's dlx command to avoid requiring it as a direct dependency.
 */
async function generateTypes(
	specPath: string,
	typesPath: string,
	logger: Logger
): Promise<void> {
	logger.info({ specPath, typesPath }, "Generating TypeScript types...");

	const projectRoot = await findProjectRoot();
	const pm = await detectPackageManager(projectRoot);
	const [cmd, ...dlxArgs] = getDlxCommand(pm);

	logger.debug({ pm, cmd }, "Using package manager for openapi-typescript");

	const result = spawnSync(
		cmd,
		[...dlxArgs, "openapi-typescript", specPath, "--output", typesPath],
		{
			stdio: "pipe",
			cwd: process.cwd(),
			shell: true,
		}
	);

	if (result.error) {
		throw new GenerationError(
			"openapi-typescript",
			`Failed to spawn: ${result.error.message}`
		);
	}

	if (result.status !== 0) {
		const stderr = result.stderr?.toString() ?? "Unknown error";
		throw new GenerationError(
			"openapi-typescript",
			`Exited with code ${result.status}: ${stderr}`
		);
	}

	logger.info("TypeScript types generated successfully");
}

/**
 * Atomic write - writes to temp file then renames.
 * This ensures the file is never in a partial state.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.tmp.${Date.now()}`;

	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, filePath);
	} catch (error) {
		// Clean up temp file if rename fails
		try {
			await unlink(tempPath);
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

/**
 * Creates a backup of existing generated files for rollback.
 */
async function createBackup(paths: GeneratorPaths): Promise<{
	typesBackup: string | null;
	operationsBackup: string | null;
	contractsBackup: string | null;
}> {
	const timestamp = Date.now();
	let typesBackup: string | null = null;
	let operationsBackup: string | null = null;
	let contractsBackup: string | null = null;

	try {
		const typesBackupPath = `${paths.types}.backup.${timestamp}`;
		await copyFile(paths.types, typesBackupPath);
		typesBackup = typesBackupPath;
	} catch {
		// No existing types file to backup
	}

	try {
		const operationsBackupPath = `${paths.operations}.backup.${timestamp}`;
		await copyFile(paths.operations, operationsBackupPath);
		operationsBackup = operationsBackupPath;
	} catch {
		// No existing operations file to backup
	}

	try {
		const contractsBackupPath = `${paths.contracts}.backup.${timestamp}`;
		await copyFile(paths.contracts, contractsBackupPath);
		contractsBackup = contractsBackupPath;
	} catch {
		// No existing contracts file to backup
	}

	return { typesBackup, operationsBackup, contractsBackup };
}

/**
 * Restores files from backup on generation failure.
 */
async function restoreFromBackup(
	backups: {
		typesBackup: string | null;
		operationsBackup: string | null;
		contractsBackup: string | null;
	},
	paths: GeneratorPaths
): Promise<void> {
	if (backups.typesBackup) {
		try {
			await rename(backups.typesBackup, paths.types);
		} catch {
			// Ignore restore errors
		}
	}

	if (backups.operationsBackup) {
		try {
			await rename(backups.operationsBackup, paths.operations);
		} catch {
			// Ignore restore errors
		}
	}

	if (backups.contractsBackup) {
		try {
			await rename(backups.contractsBackup, paths.contracts);
		} catch {
			// Ignore restore errors
		}
	}
}

/**
 * Cleans up backup files after successful generation.
 */
async function cleanupBackups(backups: {
	typesBackup: string | null;
	operationsBackup: string | null;
	contractsBackup: string | null;
}): Promise<void> {
	if (backups.typesBackup) {
		try {
			await unlink(backups.typesBackup);
		} catch {
			// Ignore cleanup errors
		}
	}

	if (backups.operationsBackup) {
		try {
			await unlink(backups.operationsBackup);
		} catch {
			// Ignore cleanup errors
		}
	}

	if (backups.contractsBackup) {
		try {
			await unlink(backups.contractsBackup);
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Checks if a file exists using access check (more efficient than reading).
 */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/* ~ =================================== ~ */
/* -- Client File Templates -- */
/* ~ =================================== ~ */

/**
 * Generates the api.helpers.ts file content.
 * Contains all utility types for extracting request/response types from OpenAPI schema.
 */
export function generateHelpersFileContent(): string {
	return `/**
 * Type utilities for extracting request/response types from OpenAPI schema.
 * 
 * This file is generated once by chowbea-axios CLI.
 * You can safely modify this file - it will NOT be overwritten.
 */

import type { paths, components, operations } from "./_generated/api.types";

/* ~ =================================== ~ */
/* -- Base Types -- */
/* ~ =================================== ~ */

/** All path templates defined by the OpenAPI paths map. */
type Paths = keyof paths;

/** HTTP methods supported by the client. */
type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

/** Resolves the OpenAPI operation schema for a given path and method. */
type Operation<P extends Paths, M extends HttpMethod> = paths[P][M];

/* ~ =================================== ~ */
/* -- Path Parameter Extraction -- */
/* ~ =================================== ~ */

/** Extracts placeholder parameter names from an OpenAPI-style path template. */
type ExtractPathParamNames<T extends string> =
	T extends \`\${string}{\${infer P}}\${infer R}\`
		? P | ExtractPathParamNames<R>
		: never;

/** Maps extracted path parameter names to a simple serializable value type. */
type PathParams<P extends Paths> = ExtractPathParamNames<P & string> extends never
	? never
	: Record<ExtractPathParamNames<P & string>, string | number | boolean>;

/* ~ =================================== ~ */
/* -- Query Parameter Extraction -- */
/* ~ =================================== ~ */

/** Extracts query parameter types from the OpenAPI operation schema. */
type QueryParams<P extends Paths, M extends HttpMethod> = Operation<P, M> extends {
	parameters: { query?: infer Q };
}
	? Q extends Record<string, unknown>
		? Q
		: never
	: never;

/* ~ =================================== ~ */
/* -- Request Body Extraction -- */
/* ~ =================================== ~ */

/** Maps OpenAPI form-data field types to their runtime equivalents. */
type MapFormDataTypes<T> = T extends Record<string, unknown>
	? {
			[K in keyof T]: K extends
				| \`\${string}image\${string}\`
				| \`\${string}file\${string}\`
				| \`\${string}attachment\${string}\`
				| \`\${string}upload\${string}\`
				| \`\${string}document\${string}\`
				| \`\${string}photo\${string}\`
				| \`\${string}video\${string}\`
				| \`\${string}media\${string}\`
				? T[K] extends string[]
					? File[]
					: T[K] extends string
						? File | Blob
						: T[K]
				: T[K];
		}
	: T;

/** Infers the request body type for a given path/method pair from OpenAPI. */
type RequestBody<P extends Paths, M extends HttpMethod> = Operation<P, M> extends {
	requestBody: { content: { "application/json": infer T } };
}
	? T extends Record<string, never>
		? Record<string, unknown>
		: T
	: Operation<P, M> extends { requestBody?: { content: { "application/json": infer T } } }
		? T extends Record<string, never>
			? Record<string, unknown>
			: T
		: Operation<P, M> extends { requestBody: { content: { "multipart/form-data": infer T } } }
			? MapFormDataTypes<T>
			: Operation<P, M> extends { requestBody?: { content: { "multipart/form-data": infer T } } }
				? MapFormDataTypes<T>
				: never;

/* ~ =================================== ~ */
/* -- Response Data Extraction -- */
/* ~ =================================== ~ */

/** Extracts all available status codes from an operation's responses. */
type AvailableStatusCodes<P extends Paths, M extends HttpMethod> = Operation<P, M> extends {
	responses: infer R;
}
	? R extends Record<string, unknown>
		? keyof R & number
		: never
	: never;

/** Infers the JSON response body type for a given status code from OpenAPI. */
type ResponseData<
	P extends Paths,
	M extends HttpMethod,
	Status extends AvailableStatusCodes<P, M> = 200 extends AvailableStatusCodes<P, M>
		? 200
		: AvailableStatusCodes<P, M>,
> = Operation<P, M> extends {
	responses: { [K in Status]: { content: { "application/json": infer T } } };
}
	? T
	: never;

/* ~ =================================== ~ */
/* -- Intellisense Helpers -- */
/* ~ =================================== ~ */

/**
 * Forces TypeScript to expand and display the full type structure.
 * Improves intellisense by showing actual type properties instead of type references.
 */
type Expand<T> = T extends (...args: infer A) => infer R
	? (...args: Expand<A>) => Expand<R>
	: T extends object
		? T extends infer O
			? { [K in keyof O]: O[K] }
			: never
		: T;

/**
 * Recursively expands nested types for better intellisense.
 * Expands all levels of nested objects to show full type structure.
 */
type ExpandRecursively<T> = T extends (...args: infer A) => infer R
	? (...args: ExpandRecursively<A>) => ExpandRecursively<R>
	: T extends object
		? T extends infer O
			? { [K in keyof O]: ExpandRecursively<O[K]> }
			: never
		: T;

/* ~ =================================== ~ */
/* -- Path-Based API Type Helpers -- */
/* ~ =================================== ~ */

/**
 * Extract request body type for a given path and method.
 * @example type CreateUserInput = ApiRequestBody<"/api/users", "post">
 */
export type ApiRequestBody<P extends Paths, M extends HttpMethod> = ExpandRecursively<
	RequestBody<P, M>
>;

/**
 * Extract response data type for a given path, method, and status code.
 * @example type UserResponse = ApiResponseData<"/api/users/{id}", "get">
 * @example type CreatedResponse = ApiResponseData<"/api/users", "post", 201>
 */
export type ApiResponseData<
	P extends Paths,
	M extends HttpMethod,
	Status extends AvailableStatusCodes<P, M> = 200 extends AvailableStatusCodes<P, M>
		? 200
		: AvailableStatusCodes<P, M>,
> = ExpandRecursively<ResponseData<P, M, Status>>;

/**
 * Extract path parameters for a given path.
 * @example type UserPathParams = ApiPathParams<"/api/users/{id}">
 */
export type ApiPathParams<P extends Paths> = ExpandRecursively<PathParams<P>>;

/**
 * Extract query parameters for a given path and method.
 * @example type ListUsersQuery = ApiQueryParams<"/api/users", "get">
 */
export type ApiQueryParams<P extends Paths, M extends HttpMethod> = ExpandRecursively<
	QueryParams<P, M>
>;

/**
 * Get all available status codes for a given path and method.
 * @example type UserStatusCodes = ApiStatusCodes<"/api/users/{id}", "get">
 */
export type ApiStatusCodes<P extends Paths, M extends HttpMethod> = AvailableStatusCodes<P, M>;

/* ~ =================================== ~ */
/* -- Operation-Based API Type Helpers -- */
/* ~ =================================== ~ */

/** Extracts all available status codes from an operation's responses by operation ID. */
type OperationStatusCodes<OpId extends keyof operations> = operations[OpId] extends {
	responses: infer R;
}
	? R extends Record<string, unknown>
		? keyof R & number
		: never
	: never;

/** Determines the default positive status code for an operation. */
type OperationPositiveStatus<OpId extends keyof operations> =
	200 extends OperationStatusCodes<OpId>
		? 200
		: 201 extends OperationStatusCodes<OpId>
			? 201
			: 202 extends OperationStatusCodes<OpId>
				? 202
				: 204 extends OperationStatusCodes<OpId>
					? 204
					: OperationStatusCodes<OpId>;

/**
 * Extract request body type by operation ID.
 * @example type CreateUserInput = ServerRequestBody<"createUser">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerRequestBody<OpId extends keyof operations> = ExpandRecursively<
	operations[OpId] extends { requestBody: { content: { "application/json": infer T } } }
		? T extends Record<string, never>
			? Record<string, unknown>
			: T
		: operations[OpId] extends { requestBody?: { content: { "application/json": infer T } } }
			? T extends Record<string, never>
				? Record<string, unknown>
				: T
			: never
>;

/**
 * Extract request parameters (path and query) by operation ID.
 * @example type GetUserParams = ServerRequestParams<"getUserById">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerRequestParams<OpId extends keyof operations> = ExpandRecursively<
	operations[OpId] extends { parameters: infer P }
		? P extends { path?: infer Path; query?: infer Query }
			? (Path extends Record<string, unknown> ? { path: Path } : {}) &
					(Query extends Record<string, unknown> ? { query?: Query } : {})
			: P extends { path?: infer Path }
				? Path extends Record<string, unknown>
					? { path: Path }
					: {}
				: P extends { query?: infer Query }
					? Query extends Record<string, unknown>
						? { query?: Query }
						: {}
					: {}
		: {}
>;

/**
 * Extract response type by operation ID with optional status code.
 * Defaults to the positive status code (200, 201, 202, or 204).
 * @example type UserResponse = ServerResponseType<"getUserById">
 * @example type NotFoundResponse = ServerResponseType<"getUserById", 404>
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerResponseType<
	OpId extends keyof operations,
	Status extends OperationStatusCodes<OpId> = OperationPositiveStatus<OpId>,
> = ExpandRecursively<
	operations[OpId] extends {
		responses: { [K in Status]: { content: { "application/json": infer T } } };
	}
		? T
		: never
>;

/**
 * Extract model/schema type from OpenAPI components.
 * @example type User = ServerModel<"UserContract">
 * @example type Meeting = ServerModel<"MeetingContract">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerModel<ModelName extends keyof components["schemas"]> = ExpandRecursively<
	components["schemas"][ModelName]
>;

/* ~ =================================== ~ */
/* -- Re-exports for Convenience -- */
/* ~ =================================== ~ */

export type { Paths, HttpMethod, Expand, ExpandRecursively };
`;
}

/**
 * Generates the auth interceptor block based on auth_mode.
 */
function generateAuthInterceptor(config: InstanceConfig): string {
	switch (config.auth_mode) {
		case "bearer-localstorage":
			return `
/** localStorage key for auth token */
export const tokenKey = "${config.token_key}";

/**
 * Request interceptor that automatically attaches the auth token.
 * Reads the token from localStorage and adds it as a Bearer header.
 */
axiosInstance.interceptors.request.use(
	(config) => {
		// Only access localStorage in browser environments
		if (typeof window !== "undefined") {
			const tokenObject = localStorage.getItem(tokenKey);

			if (tokenObject) {
				try {
					const parsed = JSON.parse(tokenObject);
					const token = parsed.state?.token || parsed.token || parsed;
					if (typeof token === "string") {
						config.headers.Authorization = \`Bearer \${token}\`;
					}
				} catch {
					// If not JSON, use as-is
					config.headers.Authorization = \`Bearer \${tokenObject}\`;
				}
			}
		}

		return config;
	},
	(error) => Promise.reject(error)
);`;

		case "custom":
			return `
/**
 * Request interceptor for authentication.
 * TODO: Implement your auth logic here.
 *
 * Examples:
 *   config.headers.Authorization = \`Bearer \${getToken()}\`;
 *   config.headers["X-API-Key"] = getApiKey();
 */
axiosInstance.interceptors.request.use(
	(config) => {
		// Add your auth logic here
		return config;
	},
	(error) => Promise.reject(error)
);`;

		case "none":
			return "";
	}
}

/**
 * Generates the api.instance.ts file content.
 */
export function generateInstanceFileContent(config: InstanceConfig): string {
	const authBlock = generateAuthInterceptor(config);

	return `/**
 * Axios instance with authentication interceptor.
 *
 * This file is generated once by chowbea-axios CLI.
 * You can safely modify this file - it will NOT be overwritten.
 */

import axios from "axios";

/**
 * Shared Axios instance configured with the API base URL.
 */
export const axiosInstance = axios.create({
	baseURL: ${config.env_accessor}.${config.base_url_env},
	withCredentials: ${config.with_credentials},
	timeout: ${config.timeout},
});
${authBlock}
`;
}

/**
 * Generates the api.error.ts file content.
 */
export function generateErrorFileContent(): string {
	return `/**
 * Result-based error handling for API calls.
 * 
 * This file is generated once by chowbea-axios CLI.
 * You can safely modify this file - it will NOT be overwritten.
 */

import { AxiosError, type AxiosResponse } from "axios";

/* ~ =================================== ~ */
/* -- Types -- */
/* ~ =================================== ~ */

/**
 * Request context for debugging - what request caused the error.
 */
export interface RequestContext {
	/** HTTP method (GET, POST, etc.) */
	method: string;
	/** URL that was called */
	url: string;
	/** Base URL from axios config */
	baseURL?: string;
	/** Query parameters */
	params?: unknown;
	/** Request body (sensitive fields redacted) */
	data?: unknown;
}

/**
 * Normalized API error with extracted message and metadata.
 */
export interface ApiError {
	/** Human-readable error message */
	message: string;
	/** Error code (NETWORK_ERROR, VALIDATION_ERROR, etc.) */
	code: string;
	/** HTTP status code (null for network errors) */
	status: number | null;
	/** What request caused this error */
	request: RequestContext;
	/** Original error response body for debugging */
	details?: unknown;
}

/**
 * Result type - API calls return this instead of throwing.
 * Success: { data: T, error: null }
 * Failure: { data: null, error: ApiError }
 */
export type Result<T> =
	| { data: T; error: null }
	| { data: null; error: ApiError };

/* ~ =================================== ~ */
/* -- Error Normalization -- */
/* ~ =================================== ~ */

/**
 * Normalizes error messages from various API response formats.
 * Handles common patterns from different backend frameworks.
 */
export function normalizeErrorMessage(error: unknown): string {
	if (!error || typeof error !== "object") {
		return "An unexpected error occurred";
	}

	const e = error as Record<string, unknown>;

	// Common: { message: "..." }
	if (typeof e.message === "string") return e.message;

	// .NET: { error: "..." } or { error: { message: "..." } }
	if (e.error) {
		if (typeof e.error === "string") return e.error;
		if (typeof (e.error as Record<string, unknown>)?.message === "string") {
			return (e.error as Record<string, unknown>).message as string;
		}
	}

	// Validation: { errors: [...] } or { errors: { field: [...] } }
	if (e.errors) {
		if (Array.isArray(e.errors)) {
			const first = e.errors[0];
			if (typeof first === "string") return first;
			if (typeof first?.message === "string") return first.message;
		} else if (typeof e.errors === "object") {
			const firstField = Object.values(e.errors)[0];
			if (Array.isArray(firstField) && firstField.length > 0) {
				return String(firstField[0]);
			}
		}
	}

	// FastAPI: { detail: "..." } or { detail: [...] }
	if (typeof e.detail === "string") return e.detail;
	if (Array.isArray(e.detail) && e.detail[0]?.msg) {
		return e.detail[0].msg;
	}

	// ASP.NET Problem Details: { title: "..." }
	if (typeof e.title === "string") return e.title;

	return "An unexpected error occurred";
}

/* ~ =================================== ~ */
/* -- Request Context Extraction -- */
/* ~ =================================== ~ */

/** Fields that should be redacted from request data */
const SENSITIVE_FIELDS = [
	"password",
	"token",
	"secret",
	"authorization",
	"apikey",
	"api_key",
	"access_token",
	"refresh_token",
];

/**
 * Redacts sensitive fields from request data for safe logging.
 */
function redactSensitive(data: unknown): unknown {
	if (!data || typeof data !== "object") return data;

	const redacted = { ...(data as Record<string, unknown>) };

	for (const key of Object.keys(redacted)) {
		if (SENSITIVE_FIELDS.some((s) => key.toLowerCase().includes(s))) {
			redacted[key] = "[REDACTED]";
		}
	}

	return redacted;
}

/**
 * Extracts request context from AxiosError for debugging.
 */
function extractRequestContext(err: AxiosError): RequestContext {
	const config = err.config;

	return {
		method: config?.method?.toUpperCase() || "UNKNOWN",
		url: config?.url || "unknown",
		baseURL: config?.baseURL,
		params: config?.params,
		data: redactSensitive(config?.data),
	};
}

/* ~ =================================== ~ */
/* -- Error Creation -- */
/* ~ =================================== ~ */

/**
 * Maps HTTP status codes to error codes.
 */
function getErrorCode(status: number): string {
	if (status >= 500) return "SERVER_ERROR";
	switch (status) {
		case 400:
			return "BAD_REQUEST";
		case 401:
			return "UNAUTHORIZED";
		case 403:
			return "FORBIDDEN";
		case 404:
			return "NOT_FOUND";
		case 409:
			return "CONFLICT";
		case 422:
			return "VALIDATION_ERROR";
		case 429:
			return "RATE_LIMITED";
		default:
			return "REQUEST_ERROR";
	}
}

/**
 * Creates an ApiError from any error.
 */
export function createApiError(err: unknown): ApiError {
	if (err instanceof AxiosError) {
		const request = extractRequestContext(err);

		// Network error (no response)
		if (!err.response) {
			return {
				message: err.code === "ECONNABORTED" 
					? "Request timed out" 
					: "Network error - please check your connection",
				code: err.code === "ECONNABORTED" ? "TIMEOUT" : "NETWORK_ERROR",
				status: null,
				request,
				details: { code: err.code, message: err.message },
			};
		}

		// Server responded with error
		const status = err.response.status;

		return {
			message: normalizeErrorMessage(err.response.data),
			code: getErrorCode(status),
			status,
			request,
			details: err.response.data,
		};
	}

	// Unknown error
	return {
		message: err instanceof Error ? err.message : "An unexpected error occurred",
		code: "UNKNOWN_ERROR",
		status: null,
		request: { method: "UNKNOWN", url: "unknown" },
		details: err,
	};
}

/* ~ =================================== ~ */
/* -- Safe Request Wrapper -- */
/* ~ =================================== ~ */

/**
 * Wraps an axios promise and returns a Result instead of throwing.
 * 
 * @example
 * \`\`\`typescript
 * const { data, error } = await safeRequest(axios.get("/users"));
 * if (error) {
 *   console.error(error.message);
 *   return;
 * }
 * console.log(data);
 * \`\`\`
 */
export async function safeRequest<T>(
	promise: Promise<AxiosResponse<T>>
): Promise<Result<T>> {
	try {
		const response = await promise;
		return { data: response.data, error: null };
	} catch (err) {
		return { data: null, error: createApiError(err) };
	}
}

/**
 * Type guard to check if a result is successful.
 */
export function isSuccess<T>(result: Result<T>): result is { data: T; error: null } {
	return result.error === null;
}

/**
 * Type guard to check if a result is an error.
 */
export function isError<T>(result: Result<T>): result is { data: null; error: ApiError } {
	return result.error !== null;
}
`;
}

/**
 * Generates the api.client.ts file content.
 */
export function generateClientFileContent(): string {
	return `/**
 * Typed HTTP client for API.
 * 
 * This file is generated once by chowbea-axios CLI.
 * You can safely modify this file - it will NOT be overwritten.
 */

import type { AxiosRequestConfig, AxiosResponse } from "axios";

import { axiosInstance } from "./api.instance";
import { safeRequest, type Result } from "./api.error";
import type { paths, components, operations } from "./_generated/api.types";
import { createOperations } from "./_generated/api.operations";

/* ~ =================================== ~ */
/* -- Type Helpers -- */
/* ~ =================================== ~ */

/** All path templates defined by the OpenAPI paths map. */
type Paths = keyof paths;

/** HTTP methods supported by the client. */
type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

/** Resolves the OpenAPI operation schema for a given path and method. */
type Operation<P extends Paths, M extends HttpMethod> = paths[P][M];

/** Extracts placeholder parameter names from an OpenAPI-style path template. */
type ExtractPathParamNames<T extends string> =
	T extends \`\${string}{\${infer P}}\${infer R}\`
		? P | ExtractPathParamNames<R>
		: never;

/** Maps extracted path parameter names to a simple serializable value type. */
type PathParams<P extends Paths> = ExtractPathParamNames<
	P & string
> extends never
	? never
	: Record<ExtractPathParamNames<P & string>, string | number | boolean>;

/** Extracts query parameter types from the OpenAPI operation schema. */
type QueryParams<P extends Paths, M extends HttpMethod> = Operation<
	P,
	M
> extends { parameters: { query?: infer Q } }
	? Q extends Record<string, unknown>
		? Q
		: never
	: never;

/** Extended Axios config that includes typed query parameters. */
type TypedAxiosConfig<P extends Paths, M extends HttpMethod> = Omit<
	AxiosRequestConfig,
	"params"
> & {
	params?: QueryParams<P, M>;
};

/** Maps OpenAPI form-data field types to their runtime equivalents. */
type MapFormDataTypes<T> = T extends Record<string, unknown>
	? {
			[K in keyof T]: K extends
				| \`\${string}image\${string}\`
				| \`\${string}file\${string}\`
				| \`\${string}attachment\${string}\`
				| \`\${string}upload\${string}\`
				| \`\${string}document\${string}\`
				| \`\${string}photo\${string}\`
				| \`\${string}video\${string}\`
				| \`\${string}media\${string}\`
				? T[K] extends string[]
					? File[]
					: T[K] extends string
						? File | Blob
						: T[K]
				: T[K];
		}
	: T;

/** Infers the request body type for a given path/method pair. */
type RequestBody<P extends Paths, M extends HttpMethod> = Operation<
	P,
	M
> extends {
	requestBody: { content: { "application/json": infer T } };
}
	? T extends Record<string, never>
		? Record<string, unknown>
		: T
	: Operation<P, M> extends {
				requestBody?: { content: { "application/json": infer T } };
			}
		? T extends Record<string, never>
			? Record<string, unknown>
			: T
		: Operation<P, M> extends {
					requestBody: { content: { "multipart/form-data": infer T } };
				}
			? MapFormDataTypes<T>
			: Operation<P, M> extends {
						requestBody?: { content: { "multipart/form-data": infer T } };
					}
				? MapFormDataTypes<T>
				: never;

/** Infers the JSON response body type for a given status code. */
type ResponseData<
	P extends Paths,
	M extends HttpMethod,
> = Operation<P, M> extends {
	responses: { 200: { content: { "application/json": infer T } } };
}
	? T
	: Operation<P, M> extends {
				responses: { 201: { content: { "application/json": infer T } } };
			}
		? T
		: unknown;

/* ~ =================================== ~ */
/* -- Utility Functions -- */
/* ~ =================================== ~ */

/**
 * Replaces {param} placeholders in a path template using provided values.
 */
function interpolatePath<P extends Paths>(
	template: P,
	params?: PathParams<P> | never
): string {
	const pathStr = String(template);
	if (!params) return pathStr;

	const missing: string[] = [];
	const result = pathStr.replace(/\\{([^}]+)\\}/g, (match, key: string) => {
		const value = (params as Record<string, unknown>)[key];
		if (value === undefined || value === null) {
			missing.push(key);
			return match;
		}
		return encodeURIComponent(String(value));
	});

	if (missing.length > 0) {
		throw new Error(
			\`Missing required path param(s): \${missing.join(", ")} for template: \${pathStr}\`
		);
	}

	return result;
}

/**
 * Checks if the request should use multipart/form-data.
 */
function shouldUseFormData(path: string, data: unknown): boolean {
	if (data instanceof FormData) return true;
	const formDataPatterns = [/\\/upload-images$/, /\\/upload$/, /\\/files\\/upload$/];
	return formDataPatterns.some((pattern) => pattern.test(path));
}

/**
 * Converts a plain object to FormData for multipart/form-data requests.
 */
function convertToFormData(data: Record<string, unknown>): FormData {
	const formData = new FormData();
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;
		if (value instanceof File || value instanceof Blob) {
			formData.append(key, value);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (item instanceof File || item instanceof Blob) {
					formData.append(key, item);
				} else {
					formData.append(key, String(item));
				}
			}
		} else {
			formData.append(key, String(value));
		}
	}
	return formData;
}

/* ~ =================================== ~ */
/* -- API Client -- */
/* ~ =================================== ~ */

/**
 * Typed API client with Result-based error handling.
 * All methods return { data, error } instead of throwing.
 */
const api = {
	/**
	 * Sends a GET request to the given OpenAPI path.
	 * Returns Result<T> - never throws.
	 */
	get<P extends Paths>(
		url: P,
		...args: PathParams<P> extends never
			? [config?: TypedAxiosConfig<P, "get">]
			: [pathParams: PathParams<P>, config?: TypedAxiosConfig<P, "get">]
	): Promise<Result<ResponseData<P, "get">>> {
		const hasPathParams = String(url).includes("{");
		const [pathParamsOrConfig, config] = args;

		const pathParams = hasPathParams
			? (pathParamsOrConfig as PathParams<P>)
			: undefined;
		const finalConfig = hasPathParams
			? (config as TypedAxiosConfig<P, "get"> | undefined)
			: (pathParamsOrConfig as TypedAxiosConfig<P, "get"> | undefined);

		return safeRequest(
			axiosInstance.get<ResponseData<P, "get">>(
				interpolatePath(url, pathParams),
				finalConfig
			)
		);
	},

	/**
	 * Sends a POST request with a body inferred from the OpenAPI spec.
	 * Returns Result<T> - never throws.
	 */
	post<P extends Paths>(
		url: P,
		data: RequestBody<P, "post">,
		...args: PathParams<P> extends never
			? [config?: TypedAxiosConfig<P, "post">]
			: [pathParams: PathParams<P>, config?: TypedAxiosConfig<P, "post">]
	): Promise<Result<ResponseData<P, "post">>> {
		const hasPathParams = String(url).includes("{");
		const [pathParamsOrConfig, config] = args;

		const pathParams = hasPathParams
			? (pathParamsOrConfig as PathParams<P>)
			: undefined;
		const finalConfig = hasPathParams
			? (config as TypedAxiosConfig<P, "post"> | undefined)
			: (pathParamsOrConfig as TypedAxiosConfig<P, "post"> | undefined);

		const resolvedPath = interpolatePath(url, pathParams);
		const requestData = shouldUseFormData(resolvedPath, data)
			? data instanceof FormData
				? data
				: convertToFormData(data as Record<string, unknown>)
			: data;

		return safeRequest(
			axiosInstance.post<ResponseData<P, "post">>(
				resolvedPath,
				requestData,
				finalConfig
			)
		);
	},

	/**
	 * Sends a PUT request with a JSON body.
	 * Returns Result<T> - never throws.
	 */
	put<P extends Paths>(
		url: P,
		data: RequestBody<P, "put">,
		...args: PathParams<P> extends never
			? [config?: TypedAxiosConfig<P, "put">]
			: [pathParams: PathParams<P>, config?: TypedAxiosConfig<P, "put">]
	): Promise<Result<ResponseData<P, "put">>> {
		const hasPathParams = String(url).includes("{");
		const [pathParamsOrConfig, config] = args;

		const pathParams = hasPathParams
			? (pathParamsOrConfig as PathParams<P>)
			: undefined;
		const finalConfig = hasPathParams
			? (config as TypedAxiosConfig<P, "put"> | undefined)
			: (pathParamsOrConfig as TypedAxiosConfig<P, "put"> | undefined);

		return safeRequest(
			axiosInstance.put<ResponseData<P, "put">>(
				interpolatePath(url, pathParams),
				data,
				finalConfig
			)
		);
	},

	/**
	 * Sends a DELETE request.
	 * Returns Result<T> - never throws.
	 */
	delete<P extends Paths>(
		url: P,
		...args: PathParams<P> extends never
			? [config?: TypedAxiosConfig<P, "delete">]
			: [pathParams: PathParams<P>, config?: TypedAxiosConfig<P, "delete">]
	): Promise<Result<ResponseData<P, "delete">>> {
		const hasPathParams = String(url).includes("{");
		const [pathParamsOrConfig, config] = args;

		const pathParams = hasPathParams
			? (pathParamsOrConfig as PathParams<P>)
			: undefined;
		const finalConfig = hasPathParams
			? (config as TypedAxiosConfig<P, "delete"> | undefined)
			: (pathParamsOrConfig as TypedAxiosConfig<P, "delete"> | undefined);

		return safeRequest(
			axiosInstance.delete<ResponseData<P, "delete">>(
				interpolatePath(url, pathParams),
				finalConfig
			)
		);
	},

	/**
	 * Sends a PATCH request with a JSON body.
	 * Returns Result<T> - never throws.
	 */
	patch<P extends Paths>(
		url: P,
		data: RequestBody<P, "patch">,
		...args: PathParams<P> extends never
			? [config?: TypedAxiosConfig<P, "patch">]
			: [pathParams: PathParams<P>, config?: TypedAxiosConfig<P, "patch">]
	): Promise<Result<ResponseData<P, "patch">>> {
		const hasPathParams = String(url).includes("{");
		const [pathParamsOrConfig, config] = args;

		const pathParams = hasPathParams
			? (pathParamsOrConfig as PathParams<P>)
			: undefined;
		const finalConfig = hasPathParams
			? (config as TypedAxiosConfig<P, "patch"> | undefined)
			: (pathParamsOrConfig as TypedAxiosConfig<P, "patch"> | undefined);

		return safeRequest(
			axiosInstance.patch<ResponseData<P, "patch">>(
				interpolatePath(url, pathParams),
				data,
				finalConfig
			)
		);
	},

	/**
	 * Operation-based API methods generated from OpenAPI operationIds.
	 * Provides semantic function names instead of raw path endpoints.
	 */
	get op() {
		return createOperations(this);
	},
};

export { api };
export type { Paths, HttpMethod, PathParams, QueryParams, RequestBody, ResponseData };

// Re-export error types for convenience
export type { ApiError, Result, RequestContext } from "./api.error";
export { createApiError, safeRequest, isSuccess, isError } from "./api.error";

// Re-export types for convenience
export type { paths, components, operations };
`;
}

/**
 * Generates client files if they don't exist.
 * Returns which files were generated.
 */
export async function generateClientFiles(options: {
	paths: GeneratorPaths;
	instanceConfig: InstanceConfig;
	logger: Logger;
	force?: boolean;
}): Promise<{
	helpers: boolean;
	instance: boolean;
	error: boolean;
	client: boolean;
}> {
	const { paths: outputPaths, instanceConfig, logger, force = false } = options;
	const result = {
		helpers: false,
		instance: false,
		error: false,
		client: false,
	};

	// Generate api.helpers.ts if it doesn't exist
	const helpersExists = await fileExists(outputPaths.helpers);
	if (!helpersExists || force) {
		logger.info(
			{ path: outputPaths.helpers },
			helpersExists ? "Regenerating api.helpers.ts" : "Creating api.helpers.ts"
		);
		const content = generateHelpersFileContent();
		await atomicWrite(outputPaths.helpers, content);
		result.helpers = true;
	} else {
		logger.debug("api.helpers.ts already exists, skipping");
	}

	// Generate api.instance.ts if it doesn't exist
	const instanceExists = await fileExists(outputPaths.instance);
	if (!instanceExists || force) {
		logger.info(
			{ path: outputPaths.instance },
			instanceExists
				? "Regenerating api.instance.ts"
				: "Creating api.instance.ts"
		);
		const content = generateInstanceFileContent(instanceConfig);
		await atomicWrite(outputPaths.instance, content);
		result.instance = true;
	} else {
		logger.debug("api.instance.ts already exists, skipping");
	}

	// Generate api.error.ts if it doesn't exist
	const errorExists = await fileExists(outputPaths.error);
	if (!errorExists || force) {
		logger.info(
			{ path: outputPaths.error },
			errorExists ? "Regenerating api.error.ts" : "Creating api.error.ts"
		);
		const content = generateErrorFileContent();
		await atomicWrite(outputPaths.error, content);
		result.error = true;
	} else {
		logger.debug("api.error.ts already exists, skipping");
	}

	// Generate api.client.ts if it doesn't exist
	const clientExists = await fileExists(outputPaths.client);
	if (!clientExists || force) {
		logger.info(
			{ path: outputPaths.client },
			clientExists ? "Regenerating api.client.ts" : "Creating api.client.ts"
		);
		const content = generateClientFileContent();
		await atomicWrite(outputPaths.client, content);
		result.client = true;
	} else {
		logger.debug("api.client.ts already exists, skipping");
	}

	return result;
}

/**
 * Main generation function that produces types and operations.
 * Includes atomic writes and rollback on failure.
 */
/**
 * Dry run result showing what would be written.
 */
export interface DryRunResult {
	/** Files that would be written */
	files: Array<{
		path: string;
		lines: number;
		action: "create" | "update";
	}>;
	/** Number of operations that would be generated */
	operationCount: number;
}

export async function generate(options: {
	paths: GeneratorPaths;
	logger: Logger;
	dryRun?: boolean;
	skipTypes?: boolean;
	skipOperations?: boolean;
}): Promise<GenerationResult & { dryRunResult?: DryRunResult }> {
	const {
		paths: outputPaths,
		logger,
		dryRun = false,
		skipTypes = false,
		skipOperations = false,
	} = options;
	const startTime = Date.now();

	// Parse spec early for both dry-run and actual generation
	const specContent = await readFile(outputPaths.spec, "utf8");
	const spec = JSON.parse(specContent);
	const operations = parseOperations(spec, logger);

	if (operations.length === 0) {
		logger.warn("No operations with operationId found in OpenAPI spec");
	} else {
		logger.debug({ count: operations.length }, "Found operations");
	}

	// Handle dry-run mode
	if (dryRun) {
		logger.info("Dry run mode - no files will be written");

		const dryRunResult: DryRunResult = {
			files: [],
			operationCount: operations.length,
		};

		// Check types file
		if (!skipTypes) {
			const typesExists = await fileExists(outputPaths.types);
			// We can't easily get line count without running openapi-typescript
			dryRunResult.files.push({
				path: outputPaths.types,
				lines: 0, // Unknown until generated
				action: typesExists ? "update" : "create",
			});
		}

		// Generate operations content to get line count
		if (!skipOperations) {
			const opsContent = generateOperationsFileContent(operations);
			const opsExists = await fileExists(outputPaths.operations);
			dryRunResult.files.push({
				path: outputPaths.operations,
				lines: opsContent.split("\n").length,
				action: opsExists ? "update" : "create",
			});

			// Check contracts file
			const contractMeta = parseContracts(spec);
			const contractsContent = generateContractsFileContent(contractMeta);
			const contractsExists = await fileExists(outputPaths.contracts);
			dryRunResult.files.push({
				path: outputPaths.contracts,
				lines: contractsContent.split("\n").length,
				action: contractsExists ? "update" : "create",
			});
		}

		const durationMs = Date.now() - startTime;

		return {
			operationCount: operations.length,
			durationMs,
			typesGenerated: false,
			operationsGenerated: false,
			contractsGenerated: false,
			dryRunResult,
		};
	}

	// Create backups of existing files
	const backups = await createBackup(outputPaths);

	try {
		let typesGenerated = false;
		let operationsGenerated = false;
		let contractsGenerated = false;

		// Step 1: Generate TypeScript types from OpenAPI spec
		if (skipTypes) {
			logger.info("Skipping types generation (--operations-only)");
		} else {
			await generateTypes(outputPaths.spec, outputPaths.types, logger);
			typesGenerated = true;
		}

		// Step 2: Generate operations file
		if (skipOperations) {
			logger.info("Skipping operations generation (--types-only)");
		} else {
			logger.info("Generating operations file...");
			const operationsContent = generateOperationsFileContent(operations);
			await atomicWrite(outputPaths.operations, operationsContent);
			operationsGenerated = true;
		}

		// Step 3: Generate contracts file (concrete type aliases for cmd+click navigation)
		if (!skipOperations) {
			logger.info("Generating contracts file...");
			const contractMeta = parseContracts(spec);
			const contractsContent = generateContractsFileContent(contractMeta);
			await atomicWrite(outputPaths.contracts, contractsContent);
			contractsGenerated = true;
		}

		// Clean up backups on success
		await cleanupBackups(backups);

		const durationMs = Date.now() - startTime;

		logger.info(
			{ operationCount: operations.length, durationMs },
			"Generation completed successfully"
		);

		return {
			operationCount: operations.length,
			durationMs,
			typesGenerated,
			operationsGenerated,
			contractsGenerated,
		};
	} catch (error) {
		// Restore from backups on failure
		logger.error({ error }, "Generation failed, restoring backups...");
		await restoreFromBackup(backups, outputPaths);

		throw error;
	}
}
