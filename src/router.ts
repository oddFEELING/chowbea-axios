import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { commandExists } from "./core/pm.js";

/**
 * Check if Bun is available on the system.
 */
function hasBun(): boolean {
	return commandExists("bun");
}

/**
 * Re-launch the current script under Bun for TUI support.
 * Returns true if Bun launched successfully, false if not.
 */
function relaunchWithBun(argv: string[]): boolean {
	// Resolve the .ts entry point next to the .js one
	const thisFile = fileURLToPath(import.meta.url);
	const binDir = resolve(dirname(thisFile), "..", "bin");
	const tsEntry = resolve(binDir, "chowbea-axios.ts");

	const result = spawnSync("bun", [tsEntry, ...argv.slice(2)], {
		stdio: "inherit",
		env: process.env,
		shell: true,
	});

	if (result.error) return false;
	process.exit(result.status ?? 0);
}

/**
 * Command router -- dispatches to TUI dashboard or headless CLI.
 */
export async function route(argv: string[]): Promise<void> {
	const args = argv.slice(2); // strip runtime and script path
	const command = args.find((a) => !a.startsWith("-"));
	const hasFlag =
		args.includes("--version") ||
		args.includes("-h") ||
		args.includes("--help") ||
		args.includes("--headless");
	const isHeadless = !process.stdout.isTTY || !process.stdin.isTTY || hasFlag;

	if (!command && !isHeadless) {
		// Already running under Bun — import TUI directly
		const isBunRuntime = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

		if (isBunRuntime) {
			const { launchDashboard } = await import("./tui/main.js");
			await launchDashboard();
			return;
		}

		// Running under Node — try to re-launch with Bun
		if (hasBun()) {
			relaunchWithBun(argv);
			return; // unreachable — relaunchWithBun calls process.exit
		}

		// No Bun available
		console.log(
			"TUI dashboard requires Bun. Install Bun (https://bun.sh) or use headless mode:\n" +
			"  chowbea-axios <command>\n",
		);
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
