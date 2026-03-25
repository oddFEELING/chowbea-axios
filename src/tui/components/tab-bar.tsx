/**
 * TabBar — horizontal tab strip for the Process Runner.
 * Shows all open tabs with status indicators and keyboard hints.
 */

import type { Tab } from "../services/tab-store.js";
import type { ProcessInfo } from "../services/process-manager.js";
import { colors } from "../theme/colors.js";

interface TabBarProps {
	tabs: Tab[];
	activeTabId: string;
	processes: ProcessInfo[];
}

function statusIndicator(status: ProcessInfo["status"]): string {
	switch (status) {
		case "running":
			return " \u25CF"; // ●
		case "stopped":
			return " \u2713"; // ✓
		case "crashed":
			return " \u2717"; // ✗
	}
}

function tabColor(
	isActive: boolean,
	proc: ProcessInfo | undefined,
): string {
	if (isActive) return colors.accent;
	if (!proc) return colors.fgDim;
	switch (proc.status) {
		case "running":
			return colors.success;
		case "crashed":
			return colors.error;
		case "stopped":
			return colors.fgDim;
	}
}

export function TabBar({ tabs, activeTabId, processes }: TabBarProps) {
	return (
		<box flexDirection="row" gap={1} paddingX={1}>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
				const proc = tab.processId
					? processes.find((p) => p.id === tab.processId)
					: undefined;
				const indicator = proc ? statusIndicator(proc.status) : "";
				const fg = tabColor(isActive, proc);

				return (
					<text
						key={tab.id}
						fg={fg}
						bg={isActive ? colors.bgHighlight : undefined}
					>
						{` ${tab.label}${indicator} `}
					</text>
				);
			})}

			<box flexGrow={1} />

			<text fg={colors.fgDim}>{"Ctrl+T new | Ctrl+W close"}</text>
		</box>
	);
}
