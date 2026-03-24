/**
 * Command router -- dispatches to TUI dashboard or headless CLI.
 */
export async function route(argv: string[]): Promise<void> {
	const args = argv.slice(2); // strip runtime and script path
	const command = args.find((a) => !a.startsWith("-"));
	const isHeadless = !process.stdout.isTTY || args.includes("--headless");

	if (!command && !isHeadless) {
		const { launchDashboard } = await import("./tui/main.js");
		await launchDashboard();
		return;
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
