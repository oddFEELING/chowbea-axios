/**
 * Watch Mode screen — start/stop continuous spec polling with live status.
 * Uses executeWatch with AbortController for cancellation support.
 */

import { useState, useRef, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { colors } from "../theme/colors.js";
import {
	executeWatch,
	type WatchCallbacks,
} from "../../core/actions/watch.js";
import { createTuiLogger, type LogEntry } from "../adapters/tui-logger.js";

type WatchPhase = "idle" | "running" | "stopping";

interface CycleInfo {
	id: number;
	changed: boolean;
	durationMs: number;
}

export function WatchModeScreen() {
	const [phase, setPhase] = useState<WatchPhase>("idle");
	const [cycles, setCycles] = useState<CycleInfo[]>([]);
	const [currentCycle, setCurrentCycle] = useState(0);
	const [lastError, setLastError] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const abortRef = useRef<AbortController | null>(null);

	const startWatch = useCallback(() => {
		if (phase === "running") return;

		const controller = new AbortController();
		abortRef.current = controller;

		setPhase("running");
		setCycles([]);
		setCurrentCycle(0);
		setLastError(null);
		setLogs([]);

		const { logger, getLogs } = createTuiLogger("info");

		// Poll logs for display
		const logInterval = setInterval(() => {
			setLogs(getLogs());
		}, 500);

		const callbacks: WatchCallbacks = {
			onCycleStart(cycleId: number) {
				setCurrentCycle(cycleId);
			},
			onCycleComplete(
				cycleId: number,
				changed: boolean,
				durationMs: number,
			) {
				setCycles((prev) => [
					...prev,
					{ id: cycleId, changed, durationMs },
				]);
			},
			onCycleError(_cycleId: number, error: Error) {
				setLastError(error.message);
			},
			onShutdown() {
				clearInterval(logInterval);
				setLogs(getLogs());
				setPhase("idle");
			},
		};

		executeWatch({ signal: controller.signal }, logger, callbacks)
			.catch(() => {
				/* watch exits via abort — not an error */
			})
			.finally(() => {
				clearInterval(logInterval);
				setPhase("idle");
			});
	}, [phase]);

	const stopWatch = useCallback(() => {
		if (!abortRef.current) return;
		setPhase("stopping");
		abortRef.current.abort();
		abortRef.current = null;
	}, []);

	useKeyboard((key) => {
		if (key.name === "return" && phase === "idle") {
			startWatch();
		}
		if (key.name === "escape" && phase === "running") {
			stopWatch();
		}
	});

	const changedCount = cycles.filter((c) => c.changed).length;

	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			{/* Header + status — compact single row */}
			<box flexDirection="row" gap={2}>
				<text fg={colors.accent}>Watch Mode</text>

				{phase === "idle" && (
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to start"}</text>
					</box>
				)}

				{phase === "running" && (
					<box flexDirection="row">
						<text fg={colors.success}>{"Watching... "}</text>
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.warning}>{"Escape"}</text>
						<text fg={colors.fgDim}>{" to stop"}</text>
					</box>
				)}

				{phase === "stopping" && (
					<text fg={colors.warning}>Stopping...</text>
				)}
			</box>

			{/* Cycle stats — compact inline, no border */}
			{cycles.length > 0 && (
				<box flexDirection="row" gap={3}>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"cycle: "}</text>
						<text fg={colors.fg}>{String(currentCycle)}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"completed: "}</text>
						<text fg={colors.fg}>{String(cycles.length)}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"changes: "}</text>
						<text
							fg={
								changedCount > 0
									? colors.success
									: colors.fgDim
							}
						>
							{String(changedCount)}
						</text>
					</box>
				</box>
			)}

			{/* Last error — compact, no padding */}
			{lastError && (
				<text fg={colors.error}>{`Error: ${lastError}`}</text>
			)}

			{/* Log panel — fills ALL remaining space */}
			<box
				border
				borderColor={colors.border}
				paddingX={1}
				flexDirection="column"
				flexGrow={1}
			>
				<text fg={colors.fgBright}>Log</text>
				<scrollbox focused={phase === "running"} flexGrow={1}>
					{logs.length === 0 ? (
						<text fg={colors.fgDim}>
							{phase === "idle"
								? "Press Enter to start watching..."
								: "Waiting for output..."}
						</text>
					) : (
						logs.slice(-200).map((entry, i) => (
							<text
								key={i}
								fg={
									entry.level === "error"
										? colors.error
										: entry.level === "warn"
											? colors.warning
											: colors.fgDim
								}
							>
								{entry.message}
							</text>
						))
					)}
				</scrollbox>
			</box>
		</box>
	);
}
