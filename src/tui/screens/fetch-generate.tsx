/**
 * Fetch & Generate screen — triggers spec fetching and code generation.
 * Shows a prompt to start, live log output during execution, and a result summary.
 */

import { useState, useCallback, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { colors } from "../theme/colors.js";
import {
	executeFetch,
	type FetchActionResult,
} from "../../core/actions/fetch.js";
import { createTuiLogger, type LogEntry } from "../adapters/tui-logger.js";
import { formatDuration } from "../../adapters/logger-interface.js";

type Phase = "idle" | "running" | "done" | "error";

export function FetchGenerateScreen() {
	const [phase, setPhase] = useState<Phase>("idle");
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [result, setResult] = useState<FetchActionResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const runningRef = useRef(false);

	const runFetch = useCallback(() => {
		if (runningRef.current) return;
		runningRef.current = true;
		setPhase("running");
		setLogs([]);
		setResult(null);
		setError(null);

		const { logger, getLogs } = createTuiLogger("info");

		// Poll logs while running
		const logInterval = setInterval(() => {
			setLogs(getLogs());
		}, 200);

		executeFetch(
			{
				force: false,
				dryRun: false,
				typesOnly: false,
				operationsOnly: false,
			},
			logger,
		)
			.then((res) => {
				clearInterval(logInterval);
				setLogs(getLogs());
				setResult(res);
				setPhase("done");
			})
			.catch((e: unknown) => {
				clearInterval(logInterval);
				setLogs(getLogs());
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
				setPhase("error");
			})
			.finally(() => {
				runningRef.current = false;
			});
	}, []);

	useKeyboard((key) => {
		if (
			key.name === "return" &&
			(phase === "idle" || phase === "done" || phase === "error")
		) {
			runFetch();
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Fetch & Generate
			</text>

			{/* Status / prompt */}
			{phase === "idle" && (
				<text fg={colors.fgDim}>
					{`Press `}
					<text fg={colors.accent}>Enter</text>
					{` to fetch spec and generate client code.`}
				</text>
			)}

			{phase === "running" && (
				<text fg={colors.info}>Fetching and generating...</text>
			)}

			{/* Live log output */}
			{logs.length > 0 && (
				<box
					border
					borderColor={colors.border}
					padding={1}
					flexDirection="column"
					maxHeight={16}
				>
					<text fg={colors.fgBright}>
						Log Output
					</text>
					<scrollbox focused={phase === "running"}>
						{logs.map((entry, i) => (
							<text
								key={i}
								fg={logColor(entry.level)}
							>{`${logPrefix(entry.level)} ${entry.message}`}</text>
						))}
					</scrollbox>
				</box>
			)}

			{/* Result summary */}
			{phase === "done" && result && (
				<box
					border
					borderColor={colors.success}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.success}>
						Fetch Complete
					</text>
					<text fg={colors.fgDim}>
						{`spec changed:  `}
						<text
							fg={result.specChanged ? colors.success : colors.fgDim}
						>
							{result.specChanged ? "yes" : "no"}
						</text>
					</text>
					<text fg={colors.fgDim}>
						{`from cache:    `}
						<text
							fg={result.fromCache ? colors.warning : colors.fg}
						>
							{result.fromCache ? "yes" : "no"}
						</text>
					</text>
					<text fg={colors.fgDim}>
						{`operations:    `}
						<text fg={colors.fg}>
							{String(result.operationCount)}
						</text>
					</text>
					<text fg={colors.fgDim}>
						{`duration:      `}
						<text fg={colors.fg}>
							{formatDuration(result.durationMs)}
						</text>
					</text>
					<text fg={colors.fgDim}>
						{`types:         `}
						<text
							fg={
								result.typesGenerated
									? colors.success
									: colors.fgDim
							}
						>
							{result.typesGenerated ? "generated" : "skipped"}
						</text>
					</text>
					<text fg={colors.fgDim}>
						{`ops output:    `}
						<text
							fg={
								result.operationsGenerated
									? colors.success
									: colors.fgDim
							}
						>
							{result.operationsGenerated
								? "generated"
								: "skipped"}
						</text>
					</text>
					<text fg={colors.fgDim}>
						{`Press `}
						<text fg={colors.accent}>Enter</text>
						{` to run again.`}
					</text>
				</box>
			)}

			{/* Error display */}
			{phase === "error" && error && (
				<box
					border
					borderColor={colors.error}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.error}>
						Error
					</text>
					<text fg={colors.error}>{error}</text>
					<text fg={colors.fgDim}>
						{`Press `}
						<text fg={colors.accent}>Enter</text>
						{` to retry.`}
					</text>
				</box>
			)}
		</box>
	);
}

/** Map log level to a theme color. */
function logColor(level: LogEntry["level"]): string {
	switch (level) {
		case "error":
			return colors.error;
		case "warn":
			return colors.warning;
		case "done":
			return colors.success;
		case "step":
			return colors.accent;
		case "debug":
			return colors.fgDim;
		default:
			return colors.fg;
	}
}

/** Short prefix symbol for each log level. */
function logPrefix(level: LogEntry["level"]): string {
	switch (level) {
		case "error":
			return "x";
		case "warn":
			return "!";
		case "done":
			return "v";
		case "step":
			return ">";
		case "debug":
			return ".";
		default:
			return "-";
	}
}
