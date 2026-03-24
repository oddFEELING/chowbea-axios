import { colors } from "../theme/colors.js";
import type { ScreenId } from "../state/types.js";

interface StatusBarProps {
	screen: ScreenId;
}

export function StatusBar({ screen }: StatusBarProps) {
	return (
		<box height={1} backgroundColor={colors.bg} paddingLeft={1}>
			<text fg={colors.fgDim}>
				{`[1-7] navigate  [Tab] focus  [Ctrl+P] palette  [q] quit  | ${screen}`}
			</text>
		</box>
	);
}
