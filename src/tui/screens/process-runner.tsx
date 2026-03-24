/**
 * Process Runner screen — placeholder for running external dev commands.
 * Will support spawning and managing child processes in a future iteration.
 */

import { colors } from "../theme/colors.js";

export function ProcessScreen() {
	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Process Runner
			</text>
			<text fg={colors.fgDim}>Run external dev commands here.</text>
			<text fg={colors.fgDim}>Coming soon.</text>
		</box>
	);
}
