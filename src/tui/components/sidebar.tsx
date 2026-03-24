import type { ScreenId } from "../state/types.js";
import { colors } from "../theme/colors.js";

export type SidebarMode = "full" | "compact" | "hidden";

const SCREENS: Array<{ id: ScreenId; label: string; key: string }> = [
	{ id: "home", label: "Home", key: "1" },
	{ id: "init", label: "Init", key: "2" },
	{ id: "fetch", label: "Fetch", key: "3" },
	{ id: "diff", label: "Diff", key: "4" },
	{ id: "validate", label: "Validate", key: "5" },
	{ id: "watch", label: "Watch", key: "6" },
	{ id: "process", label: "Processes", key: "7" },
	{ id: "inspect", label: "Inspect", key: "8" },
];

interface SidebarProps {
	activeScreen: ScreenId;
	focused: boolean;
	onNavigate: (screen: ScreenId) => void;
	mode: SidebarMode;
	locked?: boolean;
}

export function Sidebar({
	activeScreen,
	focused: _focused,
	onNavigate: _onNavigate,
	mode,
	locked = false,
}: SidebarProps) {
	void _onNavigate;
	void _focused;

	if (mode === "hidden") {
		return null;
	}

	if (mode === "compact") {
		return (
			<box
				flexDirection="column"
				width={6}
				backgroundColor={colors.bgSurface}
				padding={0}
			>
				{SCREENS.map((screen) => {
					const isActive = activeScreen === screen.id;
					const isDisabled = locked && screen.id !== "init";
					return (
						<text
							key={screen.id}
							fg={isDisabled ? colors.fgDim : isActive ? colors.accent : colors.fg}
							bg={isActive ? colors.bgHighlight : undefined}
						>
							{` ${screen.key}${isActive ? "\u2190" : " "} `}
						</text>
					);
				})}
			</box>
		);
	}

	return (
		<box
			flexDirection="column"
			width={22}
			backgroundColor={colors.bgSurface}
			paddingX={1}
			paddingY={1}
		>
			<text fg={colors.accent}>{"chowbea-axios"}</text>
			<text fg={colors.fgDim}>
				{"\u2500".repeat(18)}
			</text>
			{SCREENS.map((screen) => {
				const isActive = activeScreen === screen.id;
				const isDisabled = locked && screen.id !== "init";
				const fg = isDisabled ? colors.fgDim : isActive ? colors.accent : colors.fg;
				const suffix = isDisabled ? " \u00d7" : isActive ? " \u2190" : "";
				return (
					<text
						key={screen.id}
						fg={fg}
						content={`${screen.key}. ${screen.label}${suffix}`}
					/>
				);
			})}
			{locked && (
				<>
					<text fg={colors.fgDim}>
						{"\u2500".repeat(18)}
					</text>
					<text fg={colors.warning}>{"Setup required"}</text>
				</>
			)}
		</box>
	);
}

export { SCREENS };
