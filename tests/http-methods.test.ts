import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	GENERATABLE_HTTP_METHODS,
	HTTP_METHODS,
	isGeneratableMethod,
} from "../src/core/http-methods.js";
import { countEndpoints } from "../src/core/actions/status.js";
import { extractOperations } from "../src/core/actions/diff.js";

describe("HTTP_METHODS shared constants (#31)", () => {
	it("HTTP_METHODS includes all 8 OpenAPI 3 path-item methods", () => {
		expect(HTTP_METHODS).toEqual([
			"get",
			"post",
			"put",
			"delete",
			"patch",
			"options",
			"head",
			"trace",
		]);
	});

	it("GENERATABLE_HTTP_METHODS is the subset that the runtime client emits today", () => {
		expect([...GENERATABLE_HTTP_METHODS]).toEqual([
			"get",
			"post",
			"put",
			"delete",
			"patch",
		]);
	});

	it("isGeneratableMethod recognizes the runtime-client subset", () => {
		expect(isGeneratableMethod("get")).toBe(true);
		expect(isGeneratableMethod("patch")).toBe(true);
		expect(isGeneratableMethod("head")).toBe(false);
		expect(isGeneratableMethod("options")).toBe(false);
		expect(isGeneratableMethod("trace")).toBe(false);
		expect(isGeneratableMethod("connect")).toBe(false);
	});
});

describe("status.countEndpoints (#31 — covers all 8 methods)", () => {
	async function withSpec<T>(
		spec: object,
		fn: (specPath: string) => Promise<T>,
	): Promise<T> {
		const dir = join(
			tmpdir(),
			`chowbea-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "openapi.json");
		try {
			await writeFile(path, JSON.stringify(spec), "utf8");
			return await fn(path);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("counts HEAD, OPTIONS, and TRACE alongside the standard 5", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/a": {
					get: { responses: { "200": { description: "OK" } } },
					head: { responses: { "200": { description: "OK" } } },
					options: { responses: { "200": { description: "OK" } } },
					trace: { responses: { "200": { description: "OK" } } },
				},
				"/b": {
					post: { responses: { "201": { description: "Created" } } },
				},
			},
		};
		await withSpec(spec, async (path) => {
			const counts = await countEndpoints(path);
			expect(counts).toEqual({
				get: 1,
				post: 1,
				put: 0,
				delete: 0,
				patch: 0,
				options: 1,
				head: 1,
				trace: 1,
				total: 5,
			});
		});
	});

	it("returns zero counts when paths are absent", async () => {
		const spec = { openapi: "3.0.3", info: { title: "X", version: "1.0.0" } };
		await withSpec(spec, async (path) => {
			const counts = await countEndpoints(path);
			expect(counts.total).toBe(0);
			expect(counts.head).toBe(0);
			expect(counts.options).toBe(0);
			expect(counts.trace).toBe(0);
		});
	});
});

describe("diff.extractOperations (#31 — covers all 8 methods)", () => {
	it("includes HEAD/OPTIONS/TRACE operations in the extracted map", () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/a": {
					head: {
						operationId: "head-a",
						responses: { "200": { description: "OK" } },
					},
					options: {
						operationId: "options-a",
						responses: { "200": { description: "OK" } },
					},
					trace: {
						operationId: "trace-a",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		};
		const ops = extractOperations(spec);
		expect(ops.has("head-a")).toBe(true);
		expect(ops.has("options-a")).toBe(true);
		expect(ops.has("trace-a")).toBe(true);
		expect(ops.get("head-a")?.method).toBe("head");
	});
});
