/**
 * Init Wizard screen — placeholder for interactive project setup.
 * The full wizard with multi-step forms will be implemented in a future iteration.
 */

import { colors } from "../theme/colors.js";

export function InitScreen() {
	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Init Wizard
			</text>
			<text fg={colors.fgDim}>Interactive setup coming soon.</text>
			<text fg={colors.fgDim}>
				Use headless mode: chowbea-axios init
			</text>
		</box>
	);
}
