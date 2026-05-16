/**
 * Drift guard for the vendored `api.helpers.ts` fixture.
 *
 * The type-level tests in `api-helpers.test-d.ts` import from
 * `fixtures/sample-api.helpers.ts`, which is a verbatim copy of the
 * generator's live output (with two controlled patches: the import path,
 * and a strict-mode fix for `paths[P][M]`). If the generator changes the
 * emitted helpers without the fixture being updated, the type tests start
 * lying about what consumers actually receive.
 *
 * This test extracts the public surface (exported type declarations) from
 * both the live output and the vendored fixture, and fails if they diverge.
 * On failure, regenerate the fixture by hand from a fresh `runClientFiles()`
 * output and re-apply the documented VENDORED-PATCH lines.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { runClientFiles } from "../helpers/run-generator.js";

const FIXTURE_URL = new URL("./fixtures/sample-api.helpers.ts", import.meta.url);

/**
 * Extract the set of exported type declarations from a helpers file as a
 * normalized signature string per export. Whitespace and JSDoc are stripped;
 * the type-parameter list and equals sign are preserved.
 */
function extractExportSignatures(source: string): Set<string> {
	const signatures = new Set<string>();
	const re = /export\s+type\s+(\w+)([\s\S]*?)=/g;
	for (const match of source.matchAll(re)) {
		const name = match[1];
		const params = match[2].replace(/\s+/g, " ").trim();
		signatures.add(`${name}${params} =`);
	}
	return signatures;
}

describe("vendored api.helpers.ts fixture stays in sync with the generator", () => {
	it("exposes the same set of exported type signatures as the live output", async () => {
		const { helpers: live, cleanup } = await runClientFiles();
		try {
			const fixture = await readFile(FIXTURE_URL, "utf8");

			const liveSigs = extractExportSignatures(live);
			const fixtureSigs = extractExportSignatures(fixture);

			const onlyInLive = [...liveSigs].filter((s) => !fixtureSigs.has(s));
			const onlyInFixture = [...fixtureSigs].filter((s) => !liveSigs.has(s));

			if (onlyInLive.length > 0 || onlyInFixture.length > 0) {
				throw new Error(
					[
						"Vendored fixture has drifted from generator output.",
						"",
						"Only in LIVE generator output (missing from fixture):",
						...onlyInLive.map((s) => `  + ${s}`),
						"",
						"Only in VENDORED fixture (missing from live output):",
						...onlyInFixture.map((s) => `  - ${s}`),
						"",
						"To resolve: regenerate the fixture from a fresh `runClientFiles()`",
						"call, re-apply the documented VENDORED-PATCH lines, and update the",
						"type-level tests in api-helpers.test-d.ts to match.",
					].join("\n"),
				);
			}

			expect(liveSigs.size).toBeGreaterThan(0);
			expect(fixtureSigs).toEqual(liveSigs);
		} finally {
			await cleanup();
		}
	});
});
