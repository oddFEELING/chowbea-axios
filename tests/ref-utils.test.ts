import { describe, expect, it } from "vitest";

import {
	pickJsonContent,
	refName,
	resolveObject,
	resolveRef,
	resolveSchema,
} from "../src/core/ref-utils.js";

describe("resolveRef", () => {
	const spec = {
		components: {
			schemas: {
				User: { type: "object", properties: { id: { type: "string" } } },
			},
		},
	};

	it("resolves a simple ref", () => {
		expect(resolveRef("#/components/schemas/User", spec)).toEqual(
			spec.components.schemas.User,
		);
	});

	it("returns undefined for unresolvable path", () => {
		expect(resolveRef("#/components/schemas/Missing", spec)).toBeUndefined();
	});

	it("returns undefined for non-fragment refs", () => {
		expect(resolveRef("https://example.com/spec.json", spec)).toBeUndefined();
		expect(resolveRef("./other.json", spec)).toBeUndefined();
	});

	it("returns undefined for non-string input", () => {
		expect(resolveRef(123 as unknown as string, spec)).toBeUndefined();
	});

	// Issue #19: JSON Pointer escape sequences ~0 (~) and ~1 (/) are not decoded.
	it.fails("#19: decodes ~1 to '/' per RFC 6901", () => {
		const refs = {
			paths: {
				"/users/{id}": { get: { operationId: "x" } },
			},
		};
		// `#/paths/~1users~1{id}/get` should resolve to the GET operation.
		expect(resolveRef("#/paths/~1users~1{id}/get", refs)).toEqual({
			operationId: "x",
		});
	});

	it.fails("#19: decodes ~0 to '~' per RFC 6901", () => {
		const refs = { components: { schemas: { "weird~name": { type: "string" } } } };
		expect(resolveRef("#/components/schemas/weird~0name", refs)).toEqual({
			type: "string",
		});
	});
});

describe("refName", () => {
	it("returns the last segment", () => {
		expect(refName("#/components/schemas/User")).toBe("User");
	});

	it("falls back to the full ref for unparseable inputs", () => {
		expect(refName("not-a-ref")).toBe("not-a-ref");
	});
});

describe("resolveObject", () => {
	const spec = {
		components: {
			parameters: {
				IdParam: { name: "id", in: "path", required: true },
			},
		},
	};

	it("follows a $ref", () => {
		const obj = { $ref: "#/components/parameters/IdParam" };
		expect(resolveObject(obj, spec)).toEqual({
			name: "id",
			in: "path",
			required: true,
		});
	});

	it("returns the object as-is when there is no $ref", () => {
		const obj = { name: "limit", in: "query" };
		expect(resolveObject(obj, spec)).toEqual(obj);
	});

	it("returns the object as-is when the $ref does not resolve", () => {
		const obj = { $ref: "#/components/parameters/Missing" };
		expect(resolveObject(obj, spec)).toEqual(obj);
	});
});

describe("pickJsonContent", () => {
	it("prefers exact application/json", () => {
		const content = {
			"application/json": { schema: { type: "string" } },
			"application/xml": { schema: { type: "object" } },
		};
		expect(pickJsonContent(content)).toEqual({
			mediaType: "application/json",
			entry: { schema: { type: "string" } },
		});
	});

	it("falls back to any json-flavored media type", () => {
		const content = {
			"application/vnd.api+json": { schema: { type: "object" } },
			"text/html": { schema: {} },
		};
		expect(pickJsonContent(content)?.mediaType).toBe(
			"application/vnd.api+json",
		);
	});

	it("falls back to */* as a last resort (Swagger-generated specs)", () => {
		const content = { "*/*": { schema: { type: "string" } } };
		expect(pickJsonContent(content)?.mediaType).toBe("*/*");
	});

	it("returns null when no json-compatible content exists", () => {
		const content = {
			"text/plain": { schema: {} },
			"image/png": { schema: {} },
		};
		expect(pickJsonContent(content)).toBeNull();
	});

	it("returns null for undefined input", () => {
		expect(pickJsonContent(undefined)).toBeNull();
	});
});

describe("resolveSchema", () => {
	const spec = {};

	it("returns null for null/undefined schemas", () => {
		expect(resolveSchema(null, spec, 0, 8, new Set())).toBeNull();
		expect(resolveSchema(undefined, spec, 0, 8, new Set())).toBeNull();
	});

	it("respects max depth", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: { x: { type: "string" } },
				},
			},
		};
		const result = resolveSchema(schema, spec, 0, 1, new Set());
		// At depth 1, the top is fine, but nested should be truncated.
		expect(result?.properties?.nested?.truncated).toBe(true);
	});

	it("captures OpenAPI 3.1 array-style nullable", () => {
		const schema = { type: ["string", "null"] };
		const result = resolveSchema(schema, spec, 0, 8, new Set());
		expect(result?.type).toBe("string");
		expect(result?.nullable).toBe(true);
	});

	it("captures OpenAPI 3.0 nullable shorthand", () => {
		const schema = { type: "string", nullable: true };
		const result = resolveSchema(schema, spec, 0, 8, new Set());
		expect(result?.nullable).toBe(true);
	});

	it("preserves enum values", () => {
		const schema = { type: "string", enum: ["a", "b", "c"] };
		const result = resolveSchema(schema, spec, 0, 8, new Set());
		expect(result?.enum).toEqual(["a", "b", "c"]);
	});

	it("breaks circular $ref via the visited set", () => {
		const cyclic: Record<string, unknown> = {
			components: { schemas: {} },
		};
		(cyclic.components as { schemas: Record<string, unknown> }).schemas.User = {
			type: "object",
			properties: {
				friend: { $ref: "#/components/schemas/User" },
			},
		};
		const result = resolveSchema(
			{ $ref: "#/components/schemas/User" },
			cyclic,
			0,
			8,
			new Set(),
		);
		// Top-level is User; friend's recursive ref should be truncated.
		expect(result?.properties?.friend?.truncated).toBe(true);
	});
});
