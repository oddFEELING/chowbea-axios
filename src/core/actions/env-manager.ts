/**
 * Env file management actions.
 * Handles parsing, writing, comparing, and managing .env files.
 * Pure logic -- no TUI or React code.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvVar {
	key: string;
	value: string;
	comment?: string; // inline comment after value
}

export interface EnvFile {
	name: string; // e.g. "local", "staging", "prod", "example"
	filename: string; // e.g. ".env.local"
	path: string; // absolute path
	vars: EnvVar[];
}

export interface EnvComparison {
	key: string;
	inBlueprint: boolean;
	inEnvironment: boolean;
	value: string | null; // value in the environment (null if missing)
	blueprintValue: string | null; // value in blueprint (null if missing)
}

export interface MissingVarSummary {
	missingFromEnv: string[]; // keys in blueprint but not in env
	notInBlueprint: string[]; // keys in env but not in blueprint
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-friendly name from an env filename.
 *
 * ".env"          -> "default"
 * ".env.local"    -> "local"
 * ".env.example"  -> "example"
 */
function envNameFromFilename(filename: string): string {
	if (filename === ".env") return "default";
	// Strip the leading ".env." prefix
	const suffix = filename.replace(/^\.env\./, "");
	return suffix || "default";
}

/**
 * Returns true when `value` needs quoting in the written .env file.
 * We quote if the value contains whitespace, `#`, `"`, `'`, or is empty.
 */
function needsQuoting(value: string): boolean {
	if (value.length === 0) return false;
	return /[\s#"'\\]/.test(value);
}

/**
 * Strip surrounding quotes from a raw value string (single or double).
 */
function stripQuotes(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0];
		const last = raw[raw.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return raw.slice(1, -1);
		}
	}
	return raw;
}

/**
 * Parse a single line of an env file into an EnvVar, or return null if the
 * line should be skipped (blank line, comment-only).
 */
function parseLine(line: string): EnvVar | null {
	const trimmed = line.trim();

	// Skip empty lines and full-line comments
	if (trimmed === "" || trimmed.startsWith("#")) return null;

	// Find the first `=` -- everything before is the key
	const eqIndex = trimmed.indexOf("=");
	if (eqIndex === -1) return null; // malformed, skip

	const key = trimmed.slice(0, eqIndex).trim();
	if (key === "") return null;

	const rawRight = trimmed.slice(eqIndex + 1);

	// Determine value and optional inline comment
	let value: string;
	let comment: string | undefined;

	const rightTrimmed = rawRight.trim();

	if (rightTrimmed.startsWith('"')) {
		// Double-quoted value -- find matching closing quote
		const closingIdx = rightTrimmed.indexOf('"', 1);
		if (closingIdx !== -1) {
			value = rightTrimmed.slice(1, closingIdx);
			const afterQuote = rightTrimmed.slice(closingIdx + 1).trim();
			if (afterQuote.startsWith("#")) {
				comment = afterQuote.slice(1).trim();
			}
		} else {
			// No closing quote -- treat the rest as value
			value = stripQuotes(rightTrimmed);
		}
	} else if (rightTrimmed.startsWith("'")) {
		// Single-quoted value -- find matching closing quote
		const closingIdx = rightTrimmed.indexOf("'", 1);
		if (closingIdx !== -1) {
			value = rightTrimmed.slice(1, closingIdx);
			const afterQuote = rightTrimmed.slice(closingIdx + 1).trim();
			if (afterQuote.startsWith("#")) {
				comment = afterQuote.slice(1).trim();
			}
		} else {
			value = stripQuotes(rightTrimmed);
		}
	} else {
		// Unquoted value -- inline comment is the first unquoted `#`
		const hashIdx = rightTrimmed.indexOf("#");
		if (hashIdx !== -1) {
			value = rightTrimmed.slice(0, hashIdx).trim();
			comment = rightTrimmed.slice(hashIdx + 1).trim();
		} else {
			value = rightTrimmed.trim();
		}
	}

	return { key, value, ...(comment !== undefined ? { comment } : {}) };
}

/**
 * Serialize an EnvVar back to a single line string.
 */
function serializeLine(v: EnvVar): string {
	let valuePart: string;
	if (needsQuoting(v.value)) {
		// Escape backslashes and double quotes inside the value
		const escaped = v.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		valuePart = `"${escaped}"`;
	} else {
		valuePart = v.value;
	}

	let line = `${v.key}=${valuePart}`;
	if (v.comment) {
		line += ` # ${v.comment}`;
	}
	return line;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Read and parse an .env file into an array of EnvVar entries.
 * Returns an empty array if the file doesn't exist or can't be read.
 */
export async function parseEnvFile(filePath: string): Promise<EnvVar[]> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		return [];
	}

	const vars: EnvVar[] = [];
	for (const line of content.split("\n")) {
		const parsed = parseLine(line);
		if (parsed) vars.push(parsed);
	}
	return vars;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write an array of EnvVar entries to a file in standard `.env` format.
 * Always ends with a trailing newline.
 */
export async function writeEnvFile(
	filePath: string,
	vars: EnvVar[],
): Promise<void> {
	const lines = vars.map(serializeLine);
	await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Detect
// ---------------------------------------------------------------------------

/**
 * Scan `projectRoot` for `.env` and `.env.*` files.
 * Returns parsed EnvFile objects sorted with `.env.example` first, then
 * alphabetically by filename.
 */
export async function detectEnvFiles(projectRoot: string): Promise<EnvFile[]> {
	let entries: string[];
	try {
		entries = await readdir(projectRoot);
	} catch {
		return [];
	}

	// Match ".env" exactly, or ".env.<suffix>"
	const envFilenames = entries.filter(
		(name) => name === ".env" || /^\.env\..+$/.test(name),
	);

	const results: EnvFile[] = [];
	for (const filename of envFilenames) {
		const absPath = path.join(projectRoot, filename);
		const vars = await parseEnvFile(absPath);
		results.push({
			name: envNameFromFilename(filename),
			filename,
			path: absPath,
			vars,
		});
	}

	// Sort: .env.example first, then alphabetically by filename
	results.sort((a, b) => {
		if (a.filename === ".env.example") return -1;
		if (b.filename === ".env.example") return 1;
		return a.filename.localeCompare(b.filename);
	});

	return results;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * Compare keys between a blueprint (e.g. `.env.example`) and an environment
 * file.  Returns which keys are missing from each side.
 */
export function compareWithBlueprint(
	blueprint: EnvFile,
	env: EnvFile,
): MissingVarSummary {
	const blueprintKeys = new Set(blueprint.vars.map((v) => v.key));
	const envKeys = new Set(env.vars.map((v) => v.key));

	const missingFromEnv: string[] = [];
	for (const key of blueprintKeys) {
		if (!envKeys.has(key)) missingFromEnv.push(key);
	}

	const notInBlueprint: string[] = [];
	for (const key of envKeys) {
		if (!blueprintKeys.has(key)) notInBlueprint.push(key);
	}

	return { missingFromEnv, notInBlueprint };
}

/**
 * Produce a merged comparison of every key in both blueprint and environment.
 * Sorting: keys present in both first, then missing from env, then not in
 * blueprint.
 */
export function getFullComparison(
	blueprint: EnvFile,
	env: EnvFile,
): EnvComparison[] {
	const blueprintMap = new Map<string, string>();
	for (const v of blueprint.vars) blueprintMap.set(v.key, v.value);

	const envMap = new Map<string, string>();
	for (const v of env.vars) envMap.set(v.key, v.value);

	const allKeys = new Set<string>([...blueprintMap.keys(), ...envMap.keys()]);

	const inBoth: EnvComparison[] = [];
	const missingFromEnv: EnvComparison[] = [];
	const notInBlueprint: EnvComparison[] = [];

	for (const key of allKeys) {
		const inBp = blueprintMap.has(key);
		const inEn = envMap.has(key);

		const entry: EnvComparison = {
			key,
			inBlueprint: inBp,
			inEnvironment: inEn,
			value: inEn ? (envMap.get(key) ?? null) : null,
			blueprintValue: inBp ? (blueprintMap.get(key) ?? null) : null,
		};

		if (inBp && inEn) {
			inBoth.push(entry);
		} else if (inBp && !inEn) {
			missingFromEnv.push(entry);
		} else {
			notInBlueprint.push(entry);
		}
	}

	return [...inBoth, ...missingFromEnv, ...notInBlueprint];
}

// ---------------------------------------------------------------------------
// Blueprint creation
// ---------------------------------------------------------------------------

/**
 * Create a `.env.example` blueprint from an existing env file.
 * Non-empty values are replaced with `"your_value_here"`.
 * Empty values stay empty.  The file is written to disk.
 */
export async function createBlueprintFromEnv(
	env: EnvFile,
	projectRoot: string,
): Promise<EnvFile> {
	const blueprintVars: EnvVar[] = env.vars.map((v) => ({
		key: v.key,
		value: "",
		...(v.comment !== undefined ? { comment: v.comment } : {}),
	}));

	const filename = ".env.example";
	const absPath = path.join(projectRoot, filename);

	await writeEnvFile(absPath, blueprintVars);

	return {
		name: "example",
		filename,
		path: absPath,
		vars: blueprintVars,
	};
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

/**
 * Append a new variable to the env file.  If the key already exists the
 * value is updated in-place instead.
 */
export async function addVarToFile(
	filePath: string,
	key: string,
	value: string,
): Promise<void> {
	const vars = await parseEnvFile(filePath);
	const existing = vars.find((v) => v.key === key);

	if (existing) {
		existing.value = value;
	} else {
		vars.push({ key, value });
	}

	await writeEnvFile(filePath, vars);
}

/**
 * Remove the variable with the given key from the file.
 * No-op if the key doesn't exist.
 */
export async function removeVarFromFile(
	filePath: string,
	key: string,
): Promise<void> {
	const vars = await parseEnvFile(filePath);
	const filtered = vars.filter((v) => v.key !== key);

	// Only write if something actually changed
	if (filtered.length !== vars.length) {
		await writeEnvFile(filePath, filtered);
	}
}

/**
 * Update the value of an existing key.  No-op if the key isn't found.
 */
export async function updateVarInFile(
	filePath: string,
	key: string,
	newValue: string,
): Promise<void> {
	const vars = await parseEnvFile(filePath);
	const target = vars.find((v) => v.key === key);

	if (target) {
		target.value = newValue;
		await writeEnvFile(filePath, vars);
	}
}

// ---------------------------------------------------------------------------
// Gitignore check
// ---------------------------------------------------------------------------

/**
 * Check whether a given filename is covered by a pattern in `.gitignore`.
 * This is a simple pattern matcher -- it checks for exact filename matches
 * and common glob patterns like `.env*`, `.env.*`, and `*.local`.
 * Returns false if `.gitignore` doesn't exist.
 */
export async function isGitignored(
	projectRoot: string,
	filename: string,
): Promise<boolean> {
	const gitignorePath = path.join(projectRoot, ".gitignore");

	let content: string;
	try {
		content = await readFile(gitignorePath, "utf8");
	} catch {
		return false;
	}

	const lines = content
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));

	for (const pattern of lines) {
		// Exact match
		if (pattern === filename) return true;

		// Simple glob: patterns ending with `*` (e.g. `.env*`)
		if (pattern.endsWith("*")) {
			const prefix = pattern.slice(0, -1);
			if (filename.startsWith(prefix)) return true;
		}

		// Leading wildcard: patterns starting with `*` (e.g. `*.local`)
		if (pattern.startsWith("*")) {
			const suffix = pattern.slice(1);
			if (filename.endsWith(suffix)) return true;
		}
	}

	return false;
}
