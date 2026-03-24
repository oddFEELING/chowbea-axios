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
		} catch (err: unknown) {
			// Only swallow the Node.js .scm import error — rethrow everything else
			const code = (err as { code?: string })?.code;
			if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
				console.log(
					"TUI dashboard requires Bun. Install Bun (https://bun.sh) or use headless mode:\n" +
					"  chowbea-axios <command>\n",
				);
			} else {
				throw err;
			}
		}
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
