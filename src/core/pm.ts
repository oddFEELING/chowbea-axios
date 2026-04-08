/**
 * Package manager detection and command helpers.
 * Shared across init, generate, and fetch commands.
 */

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Supported package managers.
 */
export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/**
 * Detects the package manager based on lockfile presence.
 * Checks in order: pnpm, yarn, bun, npm. Defaults to npm if none found.
 */
export async function detectPackageManager(
	projectRoot: string
): Promise<PackageManager> {
	const lockfiles: [string, PackageManager][] = [
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["bun.lockb", "bun"],
		["package-lock.json", "npm"],
	];

	for (const [lockfile, pm] of lockfiles) {
		try {
			await access(path.join(projectRoot, lockfile));
			return pm;
		} catch {
			/* Not found */
		}
	}

	// Default to npm — it ships with every Node.js installation
	return "npm";
}

/**
 * Returns the dlx command for running a package without installing it.
 * e.g. pnpm dlx, npx, yarn dlx, bunx
 */
export function getDlxCommand(pm: PackageManager): [string, ...string[]] {
	switch (pm) {
		case "pnpm":
			return ["pnpm", "dlx"];
		case "yarn":
			return ["yarn", "dlx"];
		case "bun":
			return ["bunx"];
		case "npm":
			return ["npx"];
	}
}

/**
 * Returns the install command for adding a dependency.
 */
export function getInstallCommand(
	pm: PackageManager,
	pkg: string,
	dev = false
): [string, ...string[]] {
	switch (pm) {
		case "yarn":
			return dev ? ["yarn", "add", "-D", pkg] : ["yarn", "add", pkg];
		case "bun":
			return dev ? ["bun", "add", "-d", pkg] : ["bun", "add", pkg];
		case "npm":
			return dev
				? ["npm", "install", "-D", pkg]
				: ["npm", "install", pkg];
		case "pnpm":
			return dev ? ["pnpm", "add", "-D", pkg] : ["pnpm", "add", pkg];
	}
}

/**
 * Returns the run command prefix for executing package scripts.
 */
export function getRunCommand(pm: PackageManager): string {
	return pm === "npm" ? "npm run" : pm;
}

/**
 * Checks whether a command exists on the system PATH.
 * Uses shell: true so Windows can resolve .exe/.cmd wrappers.
 */
export function commandExists(cmd: string): boolean {
	const result = spawnSync(cmd, ["--version"], { stdio: "pipe", shell: true });
	return result.status === 0;
}
