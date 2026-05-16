/**
 * Generator hot-path benchmarks (L9).
 *
 * Tracks end-to-end generation latency on the existing fixtures.
 *
 * Run with: `npm run bench`
 *
 * These benchmarks are NOT gated in CI — they're a visibility signal so
 * that a regression in generator performance shows up before it lands.
 * Save baseline with `--outputJson baseline.json` and compare a PR run
 * with `--compare baseline.json`.
 *
 * NOTE: `runGenerator` uses `skipTypes: true`, so the openapi-typescript
 * dlx step is excluded. The numbers reflect ONLY the chowbea-axios
 * emission pipeline — which is the part that lives in this repo and the
 * part a contributor can affect.
 */

import { readFile } from "node:fs/promises";
import { bench, describe } from "vitest";

import { runClientFiles, runGenerator } from "../helpers/run-generator.js";

const FIXTURE_DIR = new URL("../fixtures/", import.meta.url);

async function loadFixture(name: string): Promise<object> {
	const url = new URL(name, FIXTURE_DIR);
	return JSON.parse(await readFile(url, "utf8"));
}

describe("generator end-to-end", async () => {
	const petstore = await loadFixture("petstore.json");
	const edgeCases = await loadFixture("edge-cases.json");

	bench("petstore", async () => {
		const { cleanup } = await runGenerator(petstore);
		await cleanup();
	});

	bench("edge-cases", async () => {
		const { cleanup } = await runGenerator(edgeCases);
		await cleanup();
	});
});

describe("client files emission (api.helpers / api.instance / api.error / api.client)", () => {
	bench("default instance config", async () => {
		const { cleanup } = await runClientFiles();
		await cleanup();
	});

	bench("bearer-localstorage auth", async () => {
		const { cleanup } = await runClientFiles({
			auth_mode: "bearer-localstorage",
			token_key: "my-token-key",
		});
		await cleanup();
	});
});
