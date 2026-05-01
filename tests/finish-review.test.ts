import { describe, expect, it } from "vitest";

import { runGenerator } from "./helpers/run-generator.js";

describe("generator: drop substring formdata heuristic (#22)", () => {
	it("multipart body fields named 'profile' / 'filename' are typed by spec, not by name", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/upload": {
					post: {
						operationId: "upload",
						requestBody: {
							content: {
								"multipart/form-data": {
									schema: {
										type: "object",
										properties: {
											file: { type: "string", format: "binary" },
											profile: { type: "string" },
											filename: { type: "string" },
										},
									},
								},
							},
						},
						responses: { "200": { description: "OK" } },
					},
				},
			},
		};
		const { contracts, operations, cleanup } = await runGenerator(spec);
		try {
			// `file` is binary → File | Blob.
			expect(contracts).toMatch(/file\?:\s*File\s*\|\s*Blob/);
			// `profile` and `filename` are plain strings — NOT misclassified.
			expect(contracts).toMatch(/profile\?:\s*string/);
			expect(contracts).toMatch(/filename\?:\s*string/);
			// And the operations file does NOT wrap the body in
			// MapFormDataTypes — check the actual usage form (with `<`)
			// rather than the literal name (which appears in the doc
			// comment explaining the removal).
			expect(operations).not.toMatch(/MapFormDataTypes</);
		} finally {
			await cleanup();
		}
	});

	it("emitted client.ts no longer includes MapFormDataTypes type definition", async () => {
		const { runClientFiles } = await import("./helpers/run-generator.js");
		const { client, cleanup } = await runClientFiles();
		try {
			// The type alias `type MapFormDataTypes<T> = …` is gone.
			expect(client).not.toMatch(/type MapFormDataTypes</);
		} finally {
			await cleanup();
		}
	});

	it("api.client.ts shouldUseFormData no longer uses path-regex heuristic", async () => {
		const { runClientFiles } = await import("./helpers/run-generator.js");
		const { client, cleanup } = await runClientFiles();
		try {
			// The simplified runtime check is just `data instanceof FormData`.
			expect(client).toMatch(/data instanceof FormData/);
			// The old path patterns are no longer in the implementation —
			// scope to the function body so we don't match the doc comment
			// that mentions the removal.
			const fnMatch = client.match(/function shouldUseFormData[\s\S]+?\n\}/);
			expect(fnMatch).not.toBeNull();
			expect(fnMatch![0]).not.toMatch(/upload-images\$/);
			expect(fnMatch![0]).not.toMatch(/formDataPatterns/);
		} finally {
			await cleanup();
		}
	});
});

describe("generator: schemaToTS resolves non-schema $ref kinds (#32)", () => {
	it("inlines a parameter $ref's underlying schema", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/items": {
					get: {
						operationId: "list-items",
						parameters: [
							{ $ref: "#/components/parameters/PageQuery" },
						],
						responses: {
							"200": {
								description: "OK",
								content: {
									"application/json": {
										schema: { type: "object", properties: { count: { type: "integer" } } },
									},
								},
							},
						},
					},
				},
			},
			components: {
				parameters: {
					PageQuery: {
						name: "page",
						in: "query",
						schema: { type: "integer" },
					},
				},
				schemas: {
					Wrapper: {
						type: "object",
						properties: {
							pageRef: { $ref: "#/components/parameters/PageQuery" },
						},
					},
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// Wrapper.pageRef should resolve to `number` (the parameter's
			// schema), not `unknown`.
			expect(contracts).toMatch(/pageRef\?:\s*number/);
			expect(contracts).not.toMatch(/pageRef\?:\s*unknown/);
		} finally {
			await cleanup();
		}
	});

	it("inlines a requestBody $ref's underlying JSON schema", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/x": {
					get: {
						operationId: "get-x",
						responses: { "200": { description: "OK" } },
					},
				},
			},
			components: {
				requestBodies: {
					CreateUserBody: {
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { name: { type: "string" } },
								},
							},
						},
					},
				},
				schemas: {
					Wrapper: {
						type: "object",
						properties: {
							body: { $ref: "#/components/requestBodies/CreateUserBody" },
						},
					},
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// body should resolve to { name?: string } via the requestBody's
			// JSON schema.
			expect(contracts).toMatch(/body\?:\s*\{\s*name\?:\s*string;?\s*\}/);
		} finally {
			await cleanup();
		}
	});

	it("inlines a response $ref's underlying JSON schema", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/x": {
					get: {
						operationId: "get-x",
						responses: { "200": { description: "OK" } },
					},
				},
			},
			components: {
				responses: {
					ErrorResponse: {
						description: "An error",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										code: { type: "integer" },
										message: { type: "string" },
									},
								},
							},
						},
					},
				},
				schemas: {
					Wrapper: {
						type: "object",
						properties: {
							lastError: { $ref: "#/components/responses/ErrorResponse" },
						},
					},
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			expect(contracts).toMatch(/lastError\?:\s*\{[^}]*code\?:\s*number/s);
			expect(contracts).toMatch(/lastError\?:\s*\{[^}]*message\?:\s*string/s);
		} finally {
			await cleanup();
		}
	});

	it("falls back to unknown for refs into unknown components subtrees", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {},
			components: {
				schemas: {
					Wrapper: {
						type: "object",
						properties: {
							strange: { $ref: "#/components/headers/X-Custom" },
						},
					},
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			expect(contracts).toMatch(/strange\?:\s*unknown/);
		} finally {
			await cleanup();
		}
	});
});

describe("generator: emits HEAD / OPTIONS / TRACE (#31 fully resolved)", () => {
	it("runtime client exposes head/options/trace methods", async () => {
		const { runClientFiles } = await import("./helpers/run-generator.js");
		const { client, cleanup } = await runClientFiles();
		try {
			expect(client).toMatch(/head<P extends Paths>/);
			expect(client).toMatch(/options<P extends Paths>/);
			expect(client).toMatch(/trace<P extends Paths>/);
		} finally {
			await cleanup();
		}
	});
});

describe("errors.formatError + cause chain (#46)", () => {
	it("renders ChowbeaAxiosError with code + recovery hint", async () => {
		const { ConfigError, formatError } = await import("../src/core/errors.js");
		const out = formatError(new ConfigError("foo", "do bar"));
		expect(out).toMatch(/Error \[CONFIG_ERROR\]: foo/);
		expect(out).toMatch(/Recovery: do bar/);
	});

	it("walks the cause chain when present", async () => {
		const { formatError } = await import("../src/core/errors.js");
		const root = new Error("socket reset");
		const mid = new Error("upstream failed");
		(mid as Error & { cause?: unknown }).cause = root;
		const top = new Error("fetch failed");
		(top as Error & { cause?: unknown }).cause = mid;
		const out = formatError(top);
		expect(out).toMatch(/Error: fetch failed/);
		expect(out).toMatch(/Caused by: upstream failed/);
		expect(out).toMatch(/Caused by: socket reset/);
	});

	it("falls back gracefully when cause is a non-Error value", async () => {
		const { formatError } = await import("../src/core/errors.js");
		const e = new Error("oops");
		(e as Error & { cause?: unknown }).cause = "literal string";
		const out = formatError(e);
		expect(out).toMatch(/Caused by: literal string/);
	});
});

describe("errors.isRecoverable distinguishes 4xx vs 5xx (#46)", () => {
	it("returns true for 5xx + 408 + 429 + connection errors", async () => {
		const { NetworkError, isRecoverable } = await import("../src/core/errors.js");
		expect(isRecoverable(new NetworkError("u", "m", 500))).toBe(true);
		expect(isRecoverable(new NetworkError("u", "m", 503))).toBe(true);
		expect(isRecoverable(new NetworkError("u", "m", 408))).toBe(true);
		expect(isRecoverable(new NetworkError("u", "m", 429))).toBe(true);
		expect(isRecoverable(new NetworkError("u", "m"))).toBe(true); // no status = connection error
	});

	it("returns false for non-retriable 4xx (401, 403, 404, 422)", async () => {
		const { NetworkError, isRecoverable } = await import("../src/core/errors.js");
		expect(isRecoverable(new NetworkError("u", "m", 400))).toBe(false);
		expect(isRecoverable(new NetworkError("u", "m", 401))).toBe(false);
		expect(isRecoverable(new NetworkError("u", "m", 403))).toBe(false);
		expect(isRecoverable(new NetworkError("u", "m", 404))).toBe(false);
		expect(isRecoverable(new NetworkError("u", "m", 422))).toBe(false);
	});
});

describe("status.formatTimeAgo (#46)", () => {
	it("clamps future-dated input to 0 (clock-skew protection)", async () => {
		const { formatTimeAgo } = await import("../src/core/actions/status.js");
		const future = new Date(Date.now() + 60_000);
		expect(formatTimeAgo(future)).toBe("0s ago");
	});

	it("renders normal past intervals correctly", async () => {
		const { formatTimeAgo } = await import("../src/core/actions/status.js");
		expect(formatTimeAgo(new Date(Date.now() - 5_000))).toMatch(/^\ds ago$/);
		expect(formatTimeAgo(new Date(Date.now() - 5 * 60_000))).toMatch(/min ago/);
		expect(formatTimeAgo(new Date(Date.now() - 5 * 3600_000))).toMatch(/h ago/);
	});
});
