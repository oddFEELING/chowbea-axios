/**
 * Command router -- dispatches to TUI dashboard or headless CLI.
 */
export async function route(argv: string[]): Promise<void> {
	const args = argv.slice(2); // strip runtime and script path
	const command = args.find((a) => !a.startsWith("-"));
	const hasFlag =
		args.includes("-v") ||
		args.includes("--version") ||
		args.includes("-h") ||
		args.includes("--help") ||
		args.includes("--headless");
	const isHeadless = !process.stdout.isTTY || hasFlag;

	if (!command && !isHeadless) {
		// TUI requires Bun / OpenTUI — fall back to headless on Node
		try {
			const { launchDashboard } = await import("./tui/main.js");
			await launchDashboard();
			return;
		} catch {
			// OpenTUI not available (Node.js) — fall through to headless
		}
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
