import type { ReactNode } from "react";
import { Sidebar } from "./sidebar.js";
import { StatusBar } from "./status-bar.js";
import type { ScreenId } from "../state/types.js";
import { colors } from "../theme/colors.js";

interface ShellProps {
	activeScreen: ScreenId;
	sidebarFocused: boolean;
	onNavigate: (screen: ScreenId) => void;
	children: ReactNode;
}

export function Shell({
	activeScreen,
	sidebarFocused,
	onNavigate,
	children,
}: ShellProps) {
	return (
		<box flexDirection="column" width="100%" height="100%">
			<box flexGrow={1} flexDirection="row">
				<Sidebar
					activeScreen={activeScreen}
					focused={sidebarFocused}
					onNavigate={onNavigate}
				/>
				<box
					flexGrow={1}
					flexDirection="column"
					backgroundColor={colors.bg}
					padding={1}
				>
					{children}
				</box>
			</box>
			<StatusBar screen={activeScreen} />
		</box>
	);
}
