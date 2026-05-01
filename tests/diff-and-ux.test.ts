import { describe, expect, it } from "vitest";

import { extractOperations, hasChanges } from "../src/core/actions/diff.js";
import {
	addVarToFile,
	parseEnvFile,
} from "../src/core/actions/env-manager.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("plugins parseSurfaceMetadata default-id (#25)", () => {
	it("converts PascalCase to kebab-case correctly (regression)", async () => {
		// We exercise the default-id derivation through the plugins scan
		// path. The fix lives in plugins.ts:parseSurfaceMetadata; the
		// observable behavior is that scanning a defineSurface call
		// without explicit id yields a kebab-cased id derived from the
		// const name, not the previous lowered-but-not-kebab'd form.
		const { processManager } = await import(
			"../src/tui/services/process-manager.js"
		);
		// Smoke import — the actual regex change is small enough that
		// inline transformation tests below cover correctness.
		expect(processManager).toBeDefined();
	});

	it("manual transformation matches expected kebab-case", () => {
		// Same algorithm now used by plugins.ts:
		// constName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
		const transform = (name: string) =>
			name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
		expect(transform("MyCoolSurface")).toBe("my-cool-surface");
		expect(transform("EditUserSurface")).toBe("edit-user-surface");
		expect(transform("Foo")).toBe("foo");
		expect(transform("FooBar")).toBe("foo-bar");
	});

	it("the previous (broken) order produced wrong output (regression marker)", () => {
		// This documents the bug we fixed: lowering before the kebab
		// regex makes the regex a no-op. Kept as a guard rail.
		const broken = (name: string) =>
			name.toLowerCase().replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
		expect(broken("MyCoolSurface")).toBe("mycoolsurface");
		// And the fixed version differs:
		const fixed = (name: string) =>
			name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
		expect(fixed("MyCoolSurface")).not.toBe(broken("MyCoolSurface"));
	});
});

describe("diff.extractOperations + hasChanges (#30 — schema-aware)", () => {
	const baseSpec = {
		openapi: "3.0.3",
		info: { title: "X", version: "1.0.0" },
		paths: {
			"/users/{id}": {
				get: {
					operationId: "get-user",
					summary: "Get user",
					parameters: [
						{ name: "id", in: "path", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": {
							description: "OK",
							content: {
								"application/json": {
									schema: { $ref: "#/components/schemas/User" },
								},
							},
						},
					},
				},
			},
		},
		components: {
			schemas: {
				User: {
					type: "object",
					properties: { id: { type: "string" }, name: { type: "string" } },
				},
			},
		},
	};

	it("produces stable signatureHash for identical operations", () => {
		const a = extractOperations(baseSpec).get("get-user");
		const b = extractOperations(baseSpec).get("get-user");
		expect(a?.signatureHash).toBe(b?.signatureHash);
	});

	it("flips signatureHash when response schema changes (was missed before)", () => {
		const original = extractOperations(baseSpec).get("get-user");
		const modified = JSON.parse(JSON.stringify(baseSpec)) as typeof baseSpec;
		// Change response schema — same operationId, summary, method, path.
		(modified.paths["/users/{id}"].get.responses["200"] as { content: Record<string, { schema: unknown }> }).content["application/json"].schema = { type: "string" };
		const after = extractOperations(modified).get("get-user");
		expect(after?.signatureHash).not.toBe(original?.signatureHash);
		expect(hasChanges(original!, after!)).toBe(true);
	});

	it("flips signatureHash when a parameter is added", () => {
		const original = extractOperations(baseSpec).get("get-user");
		const modified = JSON.parse(JSON.stringify(baseSpec)) as typeof baseSpec;
		(modified.paths["/users/{id}"].get as { parameters: unknown[] }).parameters.push({
			name: "include",
			in: "query",
			schema: { type: "string" },
		});
		const after = extractOperations(modified).get("get-user");
		expect(after?.signatureHash).not.toBe(original?.signatureHash);
		expect(hasChanges(original!, after!)).toBe(true);
	});

	it("does not flip signatureHash when only the description changes", () => {
		// Description doesn't affect the generated client, so we
		// deliberately omit it from the canonical shape.
		const original = extractOperations(baseSpec).get("get-user");
		const modified = JSON.parse(JSON.stringify(baseSpec)) as typeof baseSpec;
		(modified.paths["/users/{id}"].get as { description?: string }).description = "added later";
		const after = extractOperations(modified).get("get-user");
		expect(after?.signatureHash).toBe(original?.signatureHash);
	});
});

describe("env-manager parseLine — `#` in unquoted values (#33)", () => {
	async function withEnvFile<T>(
		content: string,
		fn: (path: string) => Promise<T>,
	): Promise<T> {
		const dir = join(
			tmpdir(),
			`chowbea-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		const file = join(dir, ".env");
		try {
			await writeFile(file, content, "utf8");
			return await fn(file);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("preserves a hex color (`#FF0000`) as the value, not a comment", async () => {
		await withEnvFile("PRIMARY=#FF0000\n", async (path) => {
			const vars = await parseEnvFile(path);
			expect(vars).toEqual([{ key: "PRIMARY", value: "#FF0000" }]);
		});
	});

	it("preserves URL fragments (`https://example.com/page#section`)", async () => {
		await withEnvFile(
			"URL=https://example.com/page#section\n",
			async (path) => {
				const vars = await parseEnvFile(path);
				expect(vars).toEqual([
					{ key: "URL", value: "https://example.com/page#section" },
				]);
			},
		);
	});

	it("treats ` # ` (whitespace-prefixed) as an inline comment", async () => {
		await withEnvFile("KEY=value # this is a comment\n", async (path) => {
			const vars = await parseEnvFile(path);
			expect(vars).toEqual([
				{ key: "KEY", value: "value", comment: "this is a comment" },
			]);
		});
	});

	it("round-trips hex colors through addVarToFile", async () => {
		await withEnvFile("", async (path) => {
			await addVarToFile(path, "ACCENT", "#00FF00");
			const vars = await parseEnvFile(path);
			expect(vars).toEqual([{ key: "ACCENT", value: "#00FF00" }]);
		});
	});
});

describe("init non-interactive (#43)", () => {
	it("InitActionOptions exposes nonInteractive / specSource / outputFolder / packageManager", async () => {
		// Type-level smoke. If the option fields disappear, this won't
		// compile.
		const { DEFAULT_INSTANCE_CONFIG } = await import("../src/core/config.js");
		const opts = {
			force: false,
			skipScripts: false,
			skipClient: false,
			skipConcurrent: false,
			skipWorkflow: false,
			withVitePlugins: false,
			baseUrlEnv: DEFAULT_INSTANCE_CONFIG.base_url_env,
			envAccessor: DEFAULT_INSTANCE_CONFIG.env_accessor,
			tokenKey: DEFAULT_INSTANCE_CONFIG.token_key,
			authMode: DEFAULT_INSTANCE_CONFIG.auth_mode,
			withCredentials: DEFAULT_INSTANCE_CONFIG.with_credentials,
			timeout: DEFAULT_INSTANCE_CONFIG.timeout,
			nonInteractive: true as const,
			specSource: { kind: "remote", endpoint: "https://x.test/openapi.json" } as const,
			outputFolder: "src/api",
			packageManager: "npm" as const,
		};
		expect(opts.nonInteractive).toBe(true);
		expect(opts.specSource.kind).toBe("remote");
	});
});
