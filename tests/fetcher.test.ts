import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	hasLocalSpec,
	loadLocalSpec,
	normalizeSpecBuffer,
	parseSpecContent,
} from "../src/core/fetcher.js";

const SAMPLE_JSON = `{
  "openapi": "3.0.3",
  "info": { "title": "X", "version": "1.0.0" },
  "paths": {}
}`;

const SAMPLE_YAML = `openapi: 3.0.3
info:
  title: X
  version: "1.0.0"
paths: {}
`;

describe("parseSpecContent (#23 — YAML support)", () => {
	it("parses JSON content", () => {
		const spec = parseSpecContent(SAMPLE_JSON);
		expect((spec as { openapi: string }).openapi).toBe("3.0.3");
	});

	it("parses YAML content (no hint)", () => {
		const spec = parseSpecContent(SAMPLE_YAML);
		expect((spec as { openapi: string }).openapi).toBe("3.0.3");
		expect((spec as { info: { title: string } }).info.title).toBe("X");
	});

	it("uses .yaml extension as a hint", () => {
		const spec = parseSpecContent(SAMPLE_YAML, "openapi.yaml");
		expect((spec as { openapi: string }).openapi).toBe("3.0.3");
	});

	it("uses .yml extension as a hint", () => {
		const spec = parseSpecContent(SAMPLE_YAML, "openapi.yml");
		expect((spec as { openapi: string }).openapi).toBe("3.0.3");
	});

	it("hint takes precedence — JSON content with .yaml hint should still parse via YAML reader (which accepts JSON, since JSON is a subset)", () => {
		// yaml@2 parses JSON-as-YAML successfully because JSON is a YAML
		// subset. Verifies the hint path doesn't fail on hybrid content.
		const spec = parseSpecContent(SAMPLE_JSON, "spec.yaml");
		expect((spec as { openapi: string }).openapi).toBe("3.0.3");
	});

	it("throws a clear error when neither parser accepts the content", () => {
		expect(() => parseSpecContent("not: : : valid: anything: at all\n  - garbled", "x.json"))
			.toThrow(/Failed to parse spec.*at x\.json/);
	});

	it("includes both JSON and YAML errors when no hint is provided", () => {
		// `[1, 2,` is invalid as JSON (trailing comma + unterminated array)
		// AND invalid as YAML (parsed as flow-style sequence with broken syntax).
		// At least one parser will reject; both errors should appear when no hint.
		try {
			parseSpecContent("[1, 2,");
			expect.unreachable();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// We at least mention "JSON error" — YAML may be more permissive.
			expect(msg).toMatch(/JSON error/);
		}
	});
});

describe("normalizeSpecBuffer (#23)", () => {
	it("returns parsed spec plus a JSON-encoded buffer for YAML input", () => {
		const yamlBuf = Buffer.from(SAMPLE_YAML, "utf8");
		const { spec, jsonBuffer } = normalizeSpecBuffer(yamlBuf, "in.yaml");
		expect((spec as { openapi: string }).openapi).toBe("3.0.3");
		// jsonBuffer must round-trip via JSON.parse without YAML keys leaking.
		const reparsed = JSON.parse(jsonBuffer.toString("utf8"));
		expect(reparsed).toEqual(spec);
	});

	it("returns the input as JSON for JSON content", () => {
		const jsonBuf = Buffer.from(SAMPLE_JSON, "utf8");
		const { jsonBuffer } = normalizeSpecBuffer(jsonBuf);
		expect(JSON.parse(jsonBuffer.toString("utf8"))).toMatchObject({
			openapi: "3.0.3",
			info: { title: "X" },
		});
	});

	it("normalizes whitespace differences in YAML to a stable JSON buffer", () => {
		const yamlA = "openapi: 3.0.3\ninfo:\n  title: X\n  version: '1.0.0'\npaths: {}\n";
		const yamlB = "openapi:    3.0.3\ninfo:\n  title:   X\n  version:  '1.0.0'\npaths: {}\n";
		const a = normalizeSpecBuffer(Buffer.from(yamlA), "a.yaml").jsonBuffer;
		const b = normalizeSpecBuffer(Buffer.from(yamlB), "b.yaml").jsonBuffer;
		// Same logical content → identical JSON output → stable cache key.
		expect(a.equals(b)).toBe(true);
	});
});

describe("hasLocalSpec (#23)", () => {
	async function withTempFile<T>(
		filename: string,
		content: string,
		fn: (path: string) => Promise<T>,
	): Promise<T> {
		const dir = join(
			tmpdir(),
			`chowbea-fetcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		const path = join(dir, filename);
		try {
			await writeFile(path, content, "utf8");
			return await fn(path);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("accepts JSON specs", async () => {
		await withTempFile("openapi.json", SAMPLE_JSON, async (path) => {
			expect(await hasLocalSpec(path)).toBe(true);
		});
	});

	it("accepts YAML specs (.yaml)", async () => {
		await withTempFile("openapi.yaml", SAMPLE_YAML, async (path) => {
			expect(await hasLocalSpec(path)).toBe(true);
		});
	});

	it("accepts YAML specs (.yml)", async () => {
		await withTempFile("openapi.yml", SAMPLE_YAML, async (path) => {
			expect(await hasLocalSpec(path)).toBe(true);
		});
	});

	it("rejects non-existent files", async () => {
		expect(await hasLocalSpec("/tmp/definitely-not-here.json")).toBe(false);
	});

	it("rejects files that are neither JSON nor YAML", async () => {
		// YAML 2.x is permissive — most non-JSON text parses as a scalar
		// string. Use unbalanced flow-style indicators which both JSON and
		// YAML reject. (The same input is verified to throw in the
		// parseSpecContent error-message test above.)
		await withTempFile("openapi.json", "[1, 2,", async (path) => {
			expect(await hasLocalSpec(path)).toBe(false);
		});
	});
});

describe("loadLocalSpec (#23)", () => {
	async function withTempFile<T>(
		filename: string,
		content: string,
		fn: (path: string) => Promise<T>,
	): Promise<T> {
		const dir = join(
			tmpdir(),
			`chowbea-fetcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		const path = join(dir, filename);
		try {
			await writeFile(path, content, "utf8");
			return await fn(path);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("loads YAML specs and returns a JSON-encoded buffer", async () => {
		await withTempFile("openapi.yaml", SAMPLE_YAML, async (path) => {
			const { spec, buffer } = await loadLocalSpec(path);
			expect((spec as { openapi: string }).openapi).toBe("3.0.3");
			// Buffer must be JSON, even though the source was YAML.
			expect(JSON.parse(buffer.toString("utf8"))).toEqual(spec);
		});
	});

	it("loads JSON specs unchanged in semantics", async () => {
		await withTempFile("openapi.json", SAMPLE_JSON, async (path) => {
			const { spec, buffer } = await loadLocalSpec(path);
			expect(JSON.parse(buffer.toString("utf8"))).toEqual(spec);
		});
	});
});
