/**
 * L5c — chowbea.config.{mjs,js} loader tests.
 *
 * Covers discovery, dynamic-import, validation, and the precedence rule
 * between named exports and `export default`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError } from "../src/core/errors.js";
import { loadHooks } from "../src/core/hooks-loader.js";
import type { Logger } from "../src/adapters/logger-interface.js";

const SILENT_LOGGER: Logger = {
	level: "silent",
	header: () => {},
	step: () => {},
	info: (() => {}) as Logger["info"],
	warn: (() => {}) as Logger["warn"],
	error: (() => {}) as Logger["error"],
	debug: (() => {}) as Logger["debug"],
	done: () => {},
	startProgress: () => {},
	stopProgress: () => {},
};

let projectRoot: string;

beforeEach(async () => {
	projectRoot = join(
		tmpdir(),
		`chowbea-hooks-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
	await rm(projectRoot, { recursive: true, force: true });
});

describe("loadHooks", () => {
	it("returns empty object when no config file is present", async () => {
		const hooks = await loadHooks(projectRoot, SILENT_LOGGER);
		expect(hooks).toEqual({});
	});

	it("loads hooks from a default-exported object in chowbea.config.mjs", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`export default {
	transform(schemaObject) {
		if (schemaObject.format === "date-time") return "DATE_MARKER";
		return undefined;
	},
};`,
		);

		const hooks = await loadHooks(projectRoot, SILENT_LOGGER);
		expect(typeof hooks.transform).toBe("function");
		expect(hooks.postTransform).toBeUndefined();
		expect(hooks.transformProperty).toBeUndefined();
	});

	it("loads hooks from named exports", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`export const transform = () => undefined;
export const postTransform = () => undefined;`,
		);

		const hooks = await loadHooks(projectRoot, SILENT_LOGGER);
		expect(typeof hooks.transform).toBe("function");
		expect(typeof hooks.postTransform).toBe("function");
		expect(hooks.transformProperty).toBeUndefined();
	});

	it("named exports override default export when both are present", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`const defaultTransform = () => "from-default";
const namedTransform = () => "from-named";

export const transform = namedTransform;
export default { transform: defaultTransform };`,
		);

		const hooks = await loadHooks(projectRoot, SILENT_LOGGER);
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		expect((hooks.transform as any)()).toBe("from-named");
	});

	it("prefers chowbea.config.mjs over chowbea.config.js when both exist", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`export const transform = () => "from-mjs";`,
		);
		await writeFile(
			join(projectRoot, "chowbea.config.js"),
			`export const transform = () => "from-js";`,
		);

		const hooks = await loadHooks(projectRoot, SILENT_LOGGER);
		// biome-ignore lint/suspicious/noExplicitAny: test introspection
		expect((hooks.transform as any)()).toBe("from-mjs");
	});

	it("throws ConfigError when an exported hook is not a function", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`export const transform = "not-a-function";`,
		);

		await expect(loadHooks(projectRoot, SILENT_LOGGER)).rejects.toThrow(
			ConfigError,
		);
		await expect(loadHooks(projectRoot, SILENT_LOGGER)).rejects.toThrow(
			/must be a function/,
		);
	});

	it("throws ConfigError when an unknown hook key is exported", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`export default { transmogrify: () => {} };`,
		);

		await expect(loadHooks(projectRoot, SILENT_LOGGER)).rejects.toThrow(
			/unknown hook "transmogrify"/,
		);
	});

	it("throws ConfigError when the config file has a syntax error", async () => {
		await writeFile(
			join(projectRoot, "chowbea.config.mjs"),
			`export const transform = (`,
		);

		await expect(loadHooks(projectRoot, SILENT_LOGGER)).rejects.toThrow(
			/Failed to load chowbea.config.mjs/,
		);
	});
});
