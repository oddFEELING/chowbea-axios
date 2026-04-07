/**
 * Shared OpenAPI `$ref` resolution utilities.
 * Used by both the inspect and validate actions.
 */

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

/** Default max depth for recursive schema resolution. */
export const MAX_SCHEMA_DEPTH = 8;

// ---------------------------------------------------------------------------
// Ref helpers
// ---------------------------------------------------------------------------

/**
 * Follows a `$ref` JSON pointer (e.g. `#/components/schemas/Foo`) through
 * the spec object and returns the resolved value.
 */
export function resolveRef(ref: string, spec: unknown): unknown {
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
export function resolveObject(
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
export function refName(ref: string): string {
	const segments = ref.split("/");
	return segments[segments.length - 1] ?? ref;
}

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

/**
 * Recursively resolves an OpenAPI schema into a `SchemaDetail`.
 *
 * Handles `$ref` pointers, circular references (via `visited` set),
 * `allOf` / `oneOf` / `anyOf` compositions, object properties, and array
 * items.  Truncates when `maxDepth` is reached.
 */
export function resolveSchema(
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
			if (typeof schema.description === "string" && !result.description) {
				result.description = schema.description;
			}
			if (schema.nullable === true) {
				result.nullable = true;
			}
			if (schema.default !== undefined && result.default === undefined) {
				result.default = schema.default;
			}
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
		const types = schema.type as string[];
		nullable = types.includes("null");
		const nonNull = types.filter((t) => t !== "null");
		type = nonNull[0] ?? "unknown";
	} else if (typeof schema.type === "string") {
		type = schema.type;
	} else if (schema.oneOf || schema.anyOf || schema.allOf) {
		type = "composite";
	}

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
			if (resolved.description && !detail.description) {
				detail.description = resolved.description;
			}
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
