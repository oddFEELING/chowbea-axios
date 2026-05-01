import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { commandExists, resolveCommand } from "./core/pm.js";

/**
 * Check if Bun is available on the system.
 */
function hasBun(): boolean {
	return commandExists("bun");
}

/**
 * Re-launch the current script under Bun for TUI support.
 *
 * Either calls `process.exit` with the child's status (success path) or
 * returns `false` after logging the spawn failure — the caller can then
 * fall back to headless mode rather than silently exiting. Issue #45.
 */
function relaunchWithBun(argv: string[]): boolean {
	// Resolve the .ts entry point next to the .js one
	const thisFile = fileURLToPath(import.meta.url);
	const binDir = resolve(dirname(thisFile), "..", "bin");
	const tsEntry = resolve(binDir, "chowbea-axios.ts");

	// No `shell: true` — user argv flows through here, and shell metacharacters
	// in user-supplied args (e.g. paths from automation) would otherwise be
	// interpreted by the shell. resolveCommand handles Windows .cmd shims.
	// Issue #16.
	const result = spawnSync(resolveCommand("bun"), [tsEntry, ...argv.slice(2)], {
		stdio: "inherit",
		env: process.env,
	});

	if (result.error) {
		console.error(
			`Failed to relaunch under Bun: ${result.error.message}\n` +
				"Falling back to headless mode.",
		);
		return false;
	}
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

		// Running under Node — try to re-launch with Bun. On success the
		// child process exits and never returns; on failure we fall through
		// to headless help with a clear message (#45).
		if (hasBun()) {
			const launched = relaunchWithBun(argv);
			if (launched) return; // unreachable — process.exit on success
			// fall through to headless on failure
		} else {
			// No Bun available — print the requires-Bun notice once and
			// return. Falling through to `runHeadless(undefined, args)` would
			// produce confusing dual output (#45).
			console.log(
				"TUI dashboard requires Bun. Install Bun (https://bun.sh) or use headless mode:\n" +
					"  chowbea-axios <command>\n",
			);
			return;
		}
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
