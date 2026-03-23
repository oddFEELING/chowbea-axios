/**
 * Command router -- dispatches to TUI dashboard or headless CLI.
 */
export async function route(argv: string[]): Promise<void> {
	const args = argv.slice(2); // strip runtime and script path
	const command = args[0];
	const isHeadless = !process.stdout.isTTY || args.includes("--headless");

	if (!command && !isHeadless) {
		// Launch TUI dashboard
		// TODO: Will be implemented in Phase 3
		console.log(
			"TUI dashboard coming soon. Use a command (e.g., 'fetch', 'status') for now.",
		);
		process.exitCode = 0;
		return;
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
