import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { runClientFiles, runGenerator } from "./helpers/run-generator.js";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

async function loadFixture(name: string): Promise<object> {
	const url = new URL(name, FIXTURE_DIR);
	return JSON.parse(await readFile(url, "utf8"));
}

describe("generator: end-to-end snapshots", () => {
	it("petstore — clean canonical spec", async () => {
		const spec = await loadFixture("petstore.json");
		const { operations, contracts, cleanup } = await runGenerator(spec);
		try {
			expect(operations).toMatchSnapshot("api.operations.ts");
			expect(contracts).toMatchSnapshot("api.contracts.ts");
		} finally {
			await cleanup();
		}
	});

	it("edge-cases — kebab/snake collision, JSDoc/enum injection, recursion, additionalProperties, HEAD method, multipart heuristic", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { operations, contracts, cleanup } = await runGenerator(spec);
		try {
			expect(operations).toMatchSnapshot("api.operations.ts");
			expect(contracts).toMatchSnapshot("api.contracts.ts");
		} finally {
			await cleanup();
		}
	});
});

describe("generator: client files (api.helpers.ts, api.instance.ts, api.error.ts, api.client.ts)", () => {
	it("default instance config snapshot", async () => {
		const { helpers, instance, error, client, cleanup } =
			await runClientFiles();
		try {
			expect(helpers).toMatchSnapshot("api.helpers.ts");
			expect(instance).toMatchSnapshot("api.instance.ts");
			expect(error).toMatchSnapshot("api.error.ts");
			expect(client).toMatchSnapshot("api.client.ts");
		} finally {
			await cleanup();
		}
	});

	it("auth_mode=bearer-localstorage emits a tokenKey constant", async () => {
		const { instance, cleanup } = await runClientFiles({
			auth_mode: "bearer-localstorage",
			token_key: "my-token-key",
		});
		try {
			expect(instance).toMatch(/export const tokenKey = "my-token-key";/);
			expect(instance).toMatch(/localStorage\.getItem\(tokenKey\)/);
		} finally {
			await cleanup();
		}
	});

	it("auth_mode=none emits no auth interceptor", async () => {
		const { instance, cleanup } = await runClientFiles({
			auth_mode: "none",
		});
		try {
			expect(instance).not.toMatch(/interceptors\.request\.use/);
			expect(instance).not.toMatch(/Authorization/);
		} finally {
			await cleanup();
		}
	});

	it("with_credentials propagates literally to axios.create", async () => {
		const { instance, cleanup } = await runClientFiles({
			with_credentials: false,
		});
		try {
			expect(instance).toMatch(/withCredentials: false,/);
		} finally {
			await cleanup();
		}
	});
});

describe("generator: known-bug regression markers", () => {
	// These tests document bugs reported in the package review (#13–#22).
	// They are written in a form that will FAIL once the bugs are fixed,
	// at which point each `.fails` should flip to a positive assertion in
	// the same PR that ships the fix. This keeps the test file as a record
	// of which bugs are still latent vs resolved.

	it("#13 (FIXED): operation keys with `-` are quoted in api.operations.ts", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			// Bare `get-user:` would be invalid TS; quoted `"get-user":` is correct.
			expect(operations).not.toMatch(/^\s+get-user:/m);
			expect(operations).toMatch(/^\s+"get-user":/m);
			// Also covers the other dashed operationIds in the fixture.
			// (`head-user` is excluded — HEAD method is skipped by the generator
			// today; that's tracked separately as issue #31.)
			expect(operations).toMatch(/^\s+"list-items":/m);
			expect(operations).toMatch(/^\s+"create-item":/m);
			expect(operations).toMatch(/^\s+"upload-file":/m);
			expect(operations).toMatch(/^\s+"get-dictionary":/m);
		} finally {
			await cleanup();
		}
	});

	it.fails("#14: descriptions containing `*/` must not break JSDoc comments", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, operations, cleanup } = await runGenerator(spec);
		try {
			// After fix, raw `*/` should not appear inside the body of any
			// JSDoc block. Today the contracts file leaks `*/ injection in
			// description` into code position.
			const body = contracts + "\n" + operations;
			// Look for `*/` followed by anything but whitespace+end-of-comment-block
			const lines = body.split("\n");
			for (const line of lines) {
				// Allow legitimate comment terminators (a line that's just */ optionally indented)
				if (/^\s*\*\/\s*$/.test(line)) continue;
				expect(line).not.toMatch(/\*\//);
			}
		} finally {
			await cleanup();
		}
	});

	it("#15 (FIXED): enum string values containing `\"` or `\\` are properly escaped", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// Spec enum: ["a\"b", "c\\d", "normal"]
			// Should emit JSON.stringify-escaped TS literals: "a\"b" | "c\\d" | "normal"
			expect(contracts).toMatch(/"a\\"b"/);
			expect(contracts).toMatch(/"c\\\\d"/);
			expect(contracts).toMatch(/"normal"/);
		} finally {
			await cleanup();
		}
	});

	it("#18 (FIXED): distinct operationIds that sanitize to the same identifier throw at generate time", async () => {
		// `get-user` and `get_user` both sanitize to `get_user`.
		const spec = {
			openapi: "3.0.3",
			info: { title: "Collision", version: "1.0.0" },
			paths: {
				"/users": {
					get: {
						operationId: "get-user",
						responses: { "200": { description: "OK" } },
					},
					post: {
						operationId: "get_user",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		};
		await expect(runGenerator(spec)).rejects.toThrow(
			/OperationId collision/,
		);
	});

	it("#18 (FIXED): collision error names every colliding pair", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "Collision", version: "1.0.0" },
			paths: {
				"/a": {
					get: { operationId: "do-thing", responses: { "200": { description: "OK" } } },
					post: { operationId: "do_thing", responses: { "200": { description: "OK" } } },
				},
				"/b": {
					get: { operationId: "list a b", responses: { "200": { description: "OK" } } },
					post: { operationId: "list-a-b", responses: { "200": { description: "OK" } } },
				},
			},
		};
		await expect(runGenerator(spec)).rejects.toThrow(/do-thing.*do_thing/s);
		await expect(runGenerator(spec)).rejects.toThrow(/list a b.*list-a-b/s);
	});

	it("#18 (FIXED): unique operationIds still generate cleanly", async () => {
		const spec = await loadFixture("petstore.json");
		const { operations, contracts, cleanup } = await runGenerator(spec);
		try {
			// Sanity: petstore has no collisions, so generation succeeds.
			expect(operations.length).toBeGreaterThan(0);
			expect(contracts.length).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});

	it.fails("#26: recursive types should reference themselves, not collapse to unknown[]", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// Today emits `friends?: unknown[]`.
			// After fix: `friends?: User[]` (or some self-referential alias).
			expect(contracts).not.toMatch(/friends\?:\s*unknown\[\]/);
		} finally {
			await cleanup();
		}
	});

	it.fails("#31: HEAD method operations should appear in api.operations.ts", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			// `head-user` operation should be emitted alongside get/patch.
			expect(operations).toMatch(/head-user/);
		} finally {
			await cleanup();
		}
	});

	it.fails("#32: additionalProperties should not be silently dropped", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// `/dictionary` GET response has additionalProperties: { type: string }.
			// After fix: emitted type should include `Record<string, string>` or
			// an index signature `[key: string]: string`.
			expect(contracts).toMatch(/Record<string,\s*string>|\[key:\s*string\]:\s*string/);
		} finally {
			await cleanup();
		}
	});
});
