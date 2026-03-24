import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Sidebar, type SidebarMode } from "./sidebar.js";
import { StatusBar } from "./status-bar.js";
import type { ScreenId } from "../state/types.js";
import { colors } from "../theme/colors.js";

interface ShellProps {
	activeScreen: ScreenId;
	sidebarFocused: boolean;
	onNavigate: (screen: ScreenId) => void;
	children: ReactNode;
	locked?: boolean;
}

export function Shell({
	activeScreen,
	sidebarFocused,
	onNavigate,
	children,
	locked = false,
}: ShellProps) {
	const { width } = useTerminalDimensions();

	const sidebarMode: SidebarMode =
		width >= 80 ? "full" : width >= 60 ? "compact" : "hidden";

	return (
		<box flexDirection="row" width="100%" height="100%">
			{sidebarMode !== "hidden" && (
				<Sidebar
					activeScreen={activeScreen}
					focused={sidebarFocused}
					onNavigate={onNavigate}
					mode={sidebarMode}
					locked={locked}
				/>
			)}
			<box flexGrow={1} flexDirection="column">
				<box
					flexGrow={1}
					flexDirection="column"
					backgroundColor={colors.bg}
					padding={1}
				>
					{children}
				</box>
				<StatusBar screen={activeScreen} locked={locked} />
			</box>
		</box>
	);
}
