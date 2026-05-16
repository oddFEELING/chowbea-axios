/**
 * L5 — hooks plumbing.
 *
 * Verifies the `transform` / `postTransform` / `transformProperty` hooks
 * exposed on `generate()` reach openapi-typescript and shape the emitted
 * `api.types.ts` accordingly.
 *
 * The canonical use case is `format: date-time` → `Date`, since it's the
 * single most-requested customisation in the openapi-typescript docs.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";

import type { GenerationHooks } from "../src/core/generator.js";
import { runGenerator } from "./helpers/run-generator.js";

const SPEC_WITH_DATETIME = {
	openapi: "3.0.3",
	info: { title: "Events API", version: "1.0.0" },
	paths: {
		"/events/{id}": {
			get: {
				operationId: "getEvent",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						description: "OK",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Event" },
							},
						},
					},
				},
			},
		},
	},
	components: {
		schemas: {
			Event: {
				type: "object",
				required: ["id", "occurredAt"],
				properties: {
					id: { type: "string" },
					occurredAt: { type: "string", format: "date-time" },
					updatedAt: { type: "string", format: "date-time", nullable: true },
				},
			},
		},
	},
};

describe("generator: openapi-typescript hooks (L5)", () => {
	it("baseline — without hooks, date-time fields are typed as `string`", async () => {
		const { types, cleanup } = await runGenerator(SPEC_WITH_DATETIME);
		try {
			expect(types).toMatch(/occurredAt:\s*string;/);
			expect(types).not.toMatch(/occurredAt:\s*Date/);
		} finally {
			await cleanup();
		}
	});

	it("transform hook converts format:date-time fields to `Date`", async () => {
		const DATE = ts.factory.createTypeReferenceNode(
			ts.factory.createIdentifier("Date"),
		);
		const NULL = ts.factory.createLiteralTypeNode(ts.factory.createNull());

		const hooks: GenerationHooks = {
			transform(schemaObject) {
				if (schemaObject.format === "date-time") {
					return "nullable" in schemaObject && schemaObject.nullable
						? ts.factory.createUnionTypeNode([DATE, NULL])
						: DATE;
				}
				return undefined;
			},
		};

		const { types, cleanup } = await runGenerator(SPEC_WITH_DATETIME, hooks);
		try {
			// Required date-time field becomes `Date`.
			expect(types).toMatch(/occurredAt:\s*Date;/);
			// Nullable date-time becomes `Date | null`.
			expect(types).toMatch(/updatedAt\??:\s*Date\s*\|\s*null/);
			// No more bare `string` for those columns.
			expect(types).not.toMatch(/occurredAt:\s*string/);
		} finally {
			await cleanup();
		}
	});

	it("transform hook receives schema objects and can opt out by returning undefined", async () => {
		let invocations = 0;
		const hooks: GenerationHooks = {
			transform() {
				invocations++;
				return undefined; // opt out — fall back to default behaviour
			},
		};

		const { types, cleanup } = await runGenerator(SPEC_WITH_DATETIME, hooks);
		try {
			// Hook fired at least once per schema object visited.
			expect(invocations).toBeGreaterThan(0);
			// Output is unchanged from baseline because every call opted out.
			expect(types).toMatch(/occurredAt:\s*string;/);
		} finally {
			await cleanup();
		}
	});
});
