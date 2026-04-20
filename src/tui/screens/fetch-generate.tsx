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
import { loadConfig } from "../../core/config.js";
import { interpolateEnvVars } from "../../core/fetcher.js";
import { createTuiLogger, type LogEntry } from "../adapters/tui-logger.js";
import { formatDuration } from "../../adapters/logger-interface.js";

type Phase = "idle" | "auth-username" | "auth-password" | "running" | "done" | "error";

export function FetchGenerateScreen() {
	const [phase, setPhase] = useState<Phase>("idle");
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [result, setResult] = useState<FetchActionResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [force, setForce] = useState(false);
	const [usernameDraft, setUsernameDraft] = useState("");
	const [passwordDraft, setPasswordDraft] = useState("");
	const [resolvedUsername, setResolvedUsername] = useState<string | undefined>();
	const forceRef = useRef(false);
	forceRef.current = force;
	const runningRef = useRef(false);

	const executeFetchWithAuth = useCallback(
		(auth?: { username: string; password: string }) => {
			setPhase("running");
			setLogs([]);
			setResult(null);
			setError(null);

			const { logger, getLogs } = createTuiLogger("info");

			const logInterval = setInterval(() => {
				setLogs(getLogs());
			}, 200);

			executeFetch(
				{
					force: forceRef.current,
					dryRun: false,
					typesOnly: false,
					operationsOnly: false,
					auth,
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
					setUsernameDraft("");
					setPasswordDraft("");
					setResolvedUsername(undefined);
				});
		},
		[],
	);

	const runFetch = useCallback(() => {
		if (runningRef.current) return;
		runningRef.current = true;

		// Check config for auth requirements before fetching
		loadConfig()
			.then(({ config }) => {
				const authCfg = config.fetch?.auth;
				if (authCfg?.type !== "basic") {
					executeFetchWithAuth(undefined);
					return;
				}

				// Try env var resolution first
				let username: string | undefined;
				let password: string | undefined;
				if (authCfg.username) {
					try {
						username = interpolateEnvVars(authCfg.username);
					} catch {
						// fall through to prompt
					}
				}
				if (authCfg.password) {
					try {
						password = interpolateEnvVars(authCfg.password);
					} catch {
						// fall through to prompt
					}
				}

				if (username && password) {
					executeFetchWithAuth({ username, password });
					return;
				}

				// Need interactive prompts — enter auth phase
				if (username) setResolvedUsername(username);
				setPhase(username ? "auth-password" : "auth-username");
				runningRef.current = false;
			})
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
				setPhase("error");
				runningRef.current = false;
			});
	}, [executeFetchWithAuth]);

	const handleUsernameSubmit = useCallback(() => {
		if (!usernameDraft.trim()) return;
		setResolvedUsername(usernameDraft.trim());
		setPhase("auth-password");
	}, [usernameDraft]);

	const handlePasswordSubmit = useCallback(() => {
		if (!passwordDraft) return;
		const username = resolvedUsername ?? usernameDraft.trim();
		runningRef.current = true;
		executeFetchWithAuth({ username, password: passwordDraft });
	}, [passwordDraft, resolvedUsername, usernameDraft, executeFetchWithAuth]);

	useKeyboard((key) => {
		if (phase === "idle" || phase === "done" || phase === "error") {
			if (key.name === "return") {
				runFetch();
			} else if (key.raw === "f") {
				setForce((prev) => !prev);
			}
		} else if (phase === "auth-username" || phase === "auth-password") {
			if (key.name === "escape") {
				setPhase("idle");
				setUsernameDraft("");
				setPasswordDraft("");
				setResolvedUsername(undefined);
				runningRef.current = false;
			}
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Fetch & Generate
			</text>

			{/* Status / prompt */}
			{phase === "idle" && (
				<box flexDirection="column" gap={0}>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to fetch spec and generate client code."}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"f"}</text>
						<text fg={colors.fgDim}>{" to toggle force mode: "}</text>
						<text fg={force ? colors.success : colors.fgDim}>
							{force ? "ON" : "OFF"}
						</text>
					</box>
				</box>
			)}

			{phase === "auth-username" && (
				<box flexDirection="column" gap={1} paddingX={1}>
					<text fg={colors.accent}>{"Basic Auth Required"}</text>
					<text fg={colors.fgDim}>
						{"The spec endpoint requires Basic Auth. Enter your credentials."}
					</text>
					<text fg={colors.fg}>{"Username:"}</text>
					<input
						value={usernameDraft}
						onInput={setUsernameDraft}
						onSubmit={handleUsernameSubmit}
						focused={true}
					/>
					<text fg={colors.fgDim}>{"Enter continue | Esc cancel"}</text>
				</box>
			)}

			{phase === "auth-password" && (
				<box flexDirection="column" gap={1} paddingX={1}>
					<text fg={colors.accent}>{"Basic Auth Required"}</text>
					<text fg={colors.fgDim}>
						{`Username: ${resolvedUsername ?? usernameDraft}`}
					</text>
					<text fg={colors.fg}>{"Password:"}</text>
					<input
						value={passwordDraft}
						onInput={setPasswordDraft}
						onSubmit={handlePasswordSubmit}
						focused={true}
					/>
					<text fg={colors.fgDim}>{"Enter continue | Esc cancel"}</text>
				</box>
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
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"spec changed:  "}</text>
						<text
							fg={result.specChanged ? colors.success : colors.fgDim}
						>
							{result.specChanged ? "yes" : "no"}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"from cache:    "}</text>
						<text
							fg={result.fromCache ? colors.warning : colors.fg}
						>
							{result.fromCache ? "yes" : "no"}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"operations:    "}</text>
						<text fg={colors.fg}>
							{String(result.operationCount)}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"duration:      "}</text>
						<text fg={colors.fg}>
							{formatDuration(result.durationMs)}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"types:         "}</text>
						<text
							fg={
								result.typesGenerated
									? colors.success
									: colors.fgDim
							}
						>
							{result.typesGenerated ? "generated" : "skipped"}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"ops output:    "}</text>
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
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to run again, "}</text>
						<text fg={colors.accent}>{"f"}</text>
						<text fg={colors.fgDim}>{" to toggle force: "}</text>
						<text fg={force ? colors.success : colors.fgDim}>
							{force ? "ON" : "OFF"}
						</text>
					</box>
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
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to retry."}</text>
					</box>
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
