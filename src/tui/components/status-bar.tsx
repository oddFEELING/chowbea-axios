import { colors } from "../theme/colors.js";
import type { ScreenId } from "../state/types.js";

interface StatusBarProps {
	screen: ScreenId;
	locked?: boolean;
}

export function StatusBar({ screen, locked = false }: StatusBarProps) {
	const hint = locked
		? "Complete setup to unlock all features  [q] quit"
		: `[1-8] navigate  [Tab] focus  [Ctrl+P] palette  [q] quit  | ${screen}`;

	return (
		<box height={1} backgroundColor={colors.bg} paddingLeft={1}>
			<text fg={locked ? colors.warning : colors.fgDim}>
				{hint}
			</text>
		</box>
	);
}
