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

	it.fails("#13: operation keys with `-` should be quoted in api.operations.ts", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			// Today the generator emits `get-user: (...) => …` (unquoted).
			// After fix: `"get-user": (...) => …`.
			expect(operations).not.toMatch(/^\s+get-user:/m);
			expect(operations).toMatch(/^\s+"get-user":/m);
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

	it.fails("#15: enum string values containing `\"` or `\\` must be properly escaped", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// Today emits `name: "a"b" | "c\d" | "normal"` (broken).
			// After fix, JSON.stringify-escaped: `name: "a\"b" | "c\\d" | "normal"`.
			expect(contracts).toMatch(/"a\\"b"/);
			expect(contracts).toMatch(/"c\\\\d"/);
		} finally {
			await cleanup();
		}
	});

	it.fails("#18: distinct operationIds that sanitize to the same identifier must be detected", async () => {
		// The fixture has both `get-user` (GET) and `get_user` (PATCH) — both
		// sanitize to `get_user`. After fix, this should throw or warn at
		// generation time. Today it silently collapses contracts.
		const spec = await loadFixture("edge-cases.json");
		await expect(runGenerator(spec)).rejects.toThrow(/collision|duplicate/i);
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
