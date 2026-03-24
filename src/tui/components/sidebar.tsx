import type { ScreenId } from "../state/types.js";
import { colors } from "../theme/colors.js";

const SCREENS: Array<{ id: ScreenId; label: string; key: string }> = [
	{ id: "home", label: "Home", key: "1" },
	{ id: "init", label: "Init", key: "2" },
	{ id: "fetch", label: "Fetch", key: "3" },
	{ id: "diff", label: "Diff", key: "4" },
	{ id: "validate", label: "Validate", key: "5" },
	{ id: "watch", label: "Watch", key: "6" },
	{ id: "process", label: "Processes", key: "7" },
];

interface SidebarProps {
	activeScreen: ScreenId;
	focused: boolean;
	onNavigate: (screen: ScreenId) => void;
}

export function Sidebar({
	activeScreen,
	focused,
	onNavigate: _onNavigate,
}: SidebarProps) {
	// onNavigate is reserved for future mouse/click-based navigation
	void _onNavigate;
	return (
		<box
			flexDirection="column"
			width={22}
			border
			borderColor={focused ? colors.borderFocus : colors.border}
			backgroundColor={colors.bgSurface}
			padding={1}
		>
			<text fg={colors.accent}>{"chowbea-axios"}</text>
			<text fg={colors.fgDim}>
				{"\u2500".repeat(18)}
			</text>
			{SCREENS.map((screen) => {
				const isActive = activeScreen === screen.id;
				return (
					<text
						key={screen.id}
						fg={isActive ? colors.accent : colors.fg}
						content={`${screen.key}. ${screen.label}${isActive ? " \u2190" : ""}`}
					/>
				);
			})}
		</box>
	);
}

export { SCREENS };
