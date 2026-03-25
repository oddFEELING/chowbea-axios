/**
 * LogViewer — full-screen process log for a single tab.
 * Shows a header with script info + status, and a scrollable output area.
 */

import type { ProcessInfo } from "../services/process-manager.js";
import { colors } from "../theme/colors.js";

interface LogViewerProps {
	process: ProcessInfo;
	focused: boolean;
}

function statusColor(status: ProcessInfo["status"]): string {
	switch (status) {
		case "running":
			return colors.success;
		case "stopped":
			return colors.fgDim;
		case "crashed":
			return colors.error;
	}
}

function statusLabel(proc: ProcessInfo): string {
	switch (proc.status) {
		case "running":
			return "running \u25CF";
		case "stopped":
			return `exited (${proc.exitCode ?? 0})`;
		case "crashed":
			return `crashed (${proc.exitCode ?? "?"})`;
	}
}

function truncate(str: string, maxLen: number): string {
	return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
}

export function LogViewer({ process: proc, focused }: LogViewerProps) {
	return (
		<box flexDirection="column" flexGrow={1}>
			{/* Header: script name + command + status */}
			<box flexDirection="row" gap={2} paddingX={1}>
				<text fg={colors.fgBright}>{proc.name}</text>
				<text fg={colors.fgDim}>
					{`$ ${truncate(proc.command, 50)}`}
				</text>
				<box flexGrow={1} />
				<text fg={statusColor(proc.status)}>
					{statusLabel(proc)}
				</text>
			</box>

			{/* Log output — fills all remaining space */}
			<box
				border
				borderColor={colors.border}
				paddingX={1}
				flexDirection="column"
				flexGrow={1}
			>
				<scrollbox focused={focused} flexGrow={1}>
					{proc.output.length === 0 ? (
						<text fg={colors.fgDim}>
							Waiting for output...
						</text>
					) : (
						proc.output.map((line, i) => (
							<text
								key={i}
								fg={
									line.stream === "stderr"
										? colors.error
										: colors.fg
								}
							>
								{line.text}
							</text>
						))
					)}
				</scrollbox>
			</box>

			{/* Context-sensitive hints */}
			<box paddingX={1}>
				<text fg={colors.fgDim}>
					{proc.status === "running"
						? "Esc kill | Ctrl+T new tab | Ctrl+W close | Left/Right switch tab"
						: "Ctrl+R re-run | Ctrl+T new tab | Ctrl+W close | Left/Right switch tab"}
				</text>
			</box>
		</box>
	);
}
