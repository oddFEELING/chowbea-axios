/**
 * Process Runner screen — reads package.json scripts and lets users
 * run them with live output. Supports multiple concurrent processes
 * with tabbed output panels.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findProjectRoot } from "../../core/config.js";
import { colors } from "../theme/colors.js";

/** Maximum number of output lines kept per process. */
const MAX_OUTPUT_LINES = 500;

/** Polling interval (ms) for flushing buffered output to state. */
const POLL_INTERVAL_MS = 200;

/** How often (ms) to re-read package.json scripts. */
const SCRIPT_REFRESH_MS = 3_000;

/** Scripts that are filtered out of the list. */
const INTERNAL_SCRIPTS = new Set([
	"prepublishOnly",
	"preinstall",
	"postinstall",
	"preuninstall",
	"postuninstall",
	"prepublish",
	"prepare",
	"preshrinkwrap",
	"shrinkwrap",
	"postshrinkwrap",
]);

interface ScriptEntry {
	name: string;
	command: string;
}

interface OutputLine {
	text: string;
	stream: "stdout" | "stderr";
}

interface ProcessInfo {
	id: string;
	name: string;
	command: string;
	output: OutputLine[];
	status: "running" | "stopped" | "crashed";
	exitCode: number | null;
}

export function ProcessScreen() {
	const [scripts, setScripts] = useState<ScriptEntry[]>([]);
	const [selectedScript, setSelectedScript] = useState(0);
	const [processes, setProcesses] = useState<ProcessInfo[]>([]);
	const [activeTab, setActiveTab] = useState(0);
	const [mode, setMode] = useState<"list" | "output">("list");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [projectRoot, setProjectRoot] = useState<string>("");

	// Refs for mutable state that avoids stale closures
	const childrenRef = useRef<Map<string, ChildProcess>>(new Map());
	const outputBufferRef = useRef<Map<string, OutputLine[]>>(new Map());
	const processListRef = useRef<ProcessInfo[]>([]);

	// Keep ref in sync with state
	useEffect(() => {
		processListRef.current = processes;
	}, [processes]);

	// ------------------------------------------------------------------
	// Load scripts from package.json — initial + periodic refresh
	// ------------------------------------------------------------------
	const loadScripts = useCallback(async () => {
		try {
			const root = projectRoot || (await findProjectRoot());
			if (!projectRoot) setProjectRoot(root);

			const raw = await readFile(`${root}/package.json`, "utf8");
			const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
			const entries: ScriptEntry[] = Object.entries(pkg.scripts ?? {})
				.filter(([name]) => !INTERNAL_SCRIPTS.has(name))
				.map(([name, command]) => ({ name, command }));

			// Only update if scripts actually changed (avoid unnecessary re-renders)
			setScripts((prev) => {
				const prevKey = prev.map((s) => `${s.name}=${s.command}`).join("|");
				const nextKey = entries
					.map((s) => `${s.name}=${s.command}`)
					.join("|");
				return prevKey === nextKey ? prev : entries;
			});
			setLoadError(null);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			setLoadError(msg);
		}
	}, [projectRoot]);

	// Initial load
	useEffect(() => {
		void loadScripts();
	}, [loadScripts]);

	// Periodic refresh to stay in sync with package.json
	useEffect(() => {
		const interval = setInterval(() => {
			void loadScripts();
		}, SCRIPT_REFRESH_MS);
		return () => clearInterval(interval);
	}, [loadScripts]);

	// ------------------------------------------------------------------
	// Poll output buffers and flush into React state
	// ------------------------------------------------------------------
	useEffect(() => {
		const interval = setInterval(() => {
			const buffers = outputBufferRef.current;
			if (buffers.size === 0) return;

			setProcesses((prev) => {
				let changed = false;
				const next = prev.map((proc) => {
					const pending = buffers.get(proc.id);
					if (!pending || pending.length === 0) return proc;

					changed = true;
					const merged = [...proc.output, ...pending].slice(-MAX_OUTPUT_LINES);
					buffers.set(proc.id, []);
					return { ...proc, output: merged };
				});
				return changed ? next : prev;
			});
		}, POLL_INTERVAL_MS);

		return () => clearInterval(interval);
	}, []);

	// ------------------------------------------------------------------
	// Cleanup all child processes on unmount
	// ------------------------------------------------------------------
	useEffect(() => {
		return () => {
			for (const child of childrenRef.current.values()) {
				try {
					child.kill("SIGTERM");
				} catch {
					// Process may have already exited
				}
			}
		};
	}, []);

	// ------------------------------------------------------------------
	// Run a script
	// ------------------------------------------------------------------
	const runScript = useCallback(
		(entry: ScriptEntry) => {
			if (!projectRoot) return;

			const id = `${entry.name}-${Date.now()}`;
			const isWindows = process.platform === "win32";
			const shell = isWindows ? "cmd" : "sh";
			const shellArgs = isWindows
				? ["/c", entry.command]
				: ["-c", entry.command];

			// Add node_modules/.bin to PATH so locally installed bins
			// (like concurrently) are found — same as npm/yarn/bun run does.
			const pathKey = isWindows ? "Path" : "PATH";
			const binDir = `${projectRoot}/node_modules/.bin`;
			const existingPath = process.env[pathKey] ?? "";
			const env = {
				...process.env,
				[pathKey]: `${binDir}:${existingPath}`,
			};

			const child = spawn(shell, shellArgs, {
				cwd: projectRoot,
				env,
			});

			childrenRef.current.set(id, child);
			outputBufferRef.current.set(id, []);

			const newProc: ProcessInfo = {
				id,
				name: entry.name,
				command: entry.command,
				output: [],
				status: "running",
				exitCode: null,
			};

			setProcesses((prev) => {
				const next = [...prev, newProc];
				// Auto-switch to the new tab
				setActiveTab(next.length - 1);
				return next;
			});

			// Stream stdout
			child.stdout?.on("data", (chunk: Buffer) => {
				const lines = chunk.toString().split("\n").filter(Boolean);
				const buffer = outputBufferRef.current.get(id);
				if (buffer) {
					for (const line of lines) {
						buffer.push({ text: line, stream: "stdout" });
					}
				}
			});

			// Stream stderr
			child.stderr?.on("data", (chunk: Buffer) => {
				const lines = chunk.toString().split("\n").filter(Boolean);
				const buffer = outputBufferRef.current.get(id);
				if (buffer) {
					for (const line of lines) {
						buffer.push({ text: line, stream: "stderr" });
					}
				}
			});

			// Handle process exit
			child.on("close", (code) => {
				childrenRef.current.delete(id);

				// Flush any remaining buffered output
				const remaining = outputBufferRef.current.get(id) ?? [];
				outputBufferRef.current.set(id, []);

				setProcesses((prev) =>
					prev.map((p) => {
						if (p.id !== id) return p;
						const merged = [...p.output, ...remaining].slice(
							-MAX_OUTPUT_LINES,
						);
						return {
							...p,
							output: merged,
							status: code === 0 ? "stopped" : "crashed",
							exitCode: code,
						};
					}),
				);
			});
		},
		[projectRoot],
	);

	// ------------------------------------------------------------------
	// Kill the active process
	// ------------------------------------------------------------------
	const killActiveProcess = useCallback(() => {
		const proc = processListRef.current[activeTab];
		if (!proc || proc.status !== "running") return;

		const child = childrenRef.current.get(proc.id);
		if (child) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already exited
			}
		}
	}, [activeTab]);

	// ------------------------------------------------------------------
	// Keyboard handling
	// ------------------------------------------------------------------
	useKeyboard((key) => {
		if (mode === "list") {
			if (key.name === "up") {
				setSelectedScript((prev) => Math.max(0, prev - 1));
			}
			if (key.name === "down") {
				setSelectedScript((prev) =>
					Math.min(scripts.length - 1, prev + 1),
				);
			}
			if (key.name === "return" && scripts.length > 0) {
				const entry = scripts[selectedScript];
				if (entry) runScript(entry);
				setMode("output");
			}
		}

		if (mode === "output") {
			if (key.name === "left") {
				setActiveTab((prev) => Math.max(0, prev - 1));
			}
			if (key.name === "right") {
				setActiveTab((prev) =>
					Math.min(processes.length - 1, prev + 1),
				);
			}
			if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
				killActiveProcess();
			}
		}

		// Tab toggles between modes
		if (key.name === "tab") {
			setMode((prev) => (prev === "list" ? "output" : "list"));
		}
	});

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/** Truncate a string to a given length. */
	function truncate(str: string, maxLen: number): string {
		return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
	}

	/** Status color for a process. */
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

	/** Status label for a process. */
	function statusLabel(proc: ProcessInfo): string {
		switch (proc.status) {
			case "running":
				return "running";
			case "stopped":
				return `exited (${proc.exitCode ?? 0})`;
			case "crashed":
				return `crashed (${proc.exitCode ?? "?"})`;
		}
	}

	// ------------------------------------------------------------------
	// Render
	// ------------------------------------------------------------------

	if (loadError) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>Process Runner</text>
				<text fg={colors.error}>{`Error: ${loadError}`}</text>
			</box>
		);
	}

	if (scripts.length === 0) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>Process Runner</text>
				<text fg={colors.fgDim}>
					No scripts found in package.json.
				</text>
			</box>
		);
	}

	const activeProcess = processes[activeTab] as ProcessInfo | undefined;

	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			<text fg={colors.accent}>Process Runner</text>

			{/* Script list panel — fixed height, scrollable */}
			<box
				border
				borderColor={mode === "list" ? colors.borderFocus : colors.border}
				paddingX={1}
				flexDirection="column"
				height={Math.min(scripts.length + 3, 12)}
			>
				<box flexDirection="row" gap={2}>
					<text fg={colors.fgBright}>Scripts</text>
					<text fg={colors.fgDim}>
						{mode === "list"
							? "Up/Down select | Enter run | Tab switch"
							: "Tab to switch"}
					</text>
				</box>

				<scrollbox focused={mode === "list"} flexGrow={1}>
					{scripts.map((entry, i) => {
						const isSelected = i === selectedScript;
						const prefix = isSelected ? "> " : "  ";
						const label = `${prefix}${entry.name}`;
						const cmdPreview = truncate(entry.command, 40);
						return (
							<box
								key={entry.name}
								flexDirection="row"
							>
								<text fg={isSelected ? colors.accent : colors.fg}>
									{`${label}  `}
								</text>
								<text fg={colors.fgDim}>{cmdPreview}</text>
							</box>
						);
					})}
				</scrollbox>
			</box>

			{/* Process output panel — fills ALL remaining space */}
			<box
				border
				borderColor={mode === "output" ? colors.borderFocus : colors.border}
				paddingX={1}
				flexDirection="column"
				flexGrow={1}
			>
				{/* Tab bar + active process info */}
				<box flexDirection="row" gap={1}>
					<text fg={colors.fgBright}>Output</text>
					{processes.length > 0 && (
						<>
							{processes.map((proc, i) => {
								const isActive = i === activeTab;
								const tabLabel = `[${proc.name}]`;
								return (
									<text
										key={proc.id}
										fg={
											isActive
												? colors.accent
												: statusColor(proc.status)
										}
									>
										{tabLabel}
									</text>
								);
							})}
						</>
					)}
				</box>

				{activeProcess && (
					<box flexDirection="row">
						<text fg={colors.fgDim}>
							{`$ ${truncate(activeProcess.command, 60)}  `}
						</text>
						<text fg={statusColor(activeProcess.status)}>
							{statusLabel(activeProcess)}
						</text>
					</box>
				)}

				{/* Output scrollbox — fills remaining panel space */}
				{activeProcess ? (
					<scrollbox focused={mode === "output"} flexGrow={1}>
						{activeProcess.output.length === 0 ? (
							<text fg={colors.fgDim}>
								Waiting for output...
							</text>
						) : (
							activeProcess.output.map((line, i) => (
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
				) : (
					<text fg={colors.fgDim}>
						No processes running. Select a script and press Enter.
					</text>
				)}

				{/* Controls hint */}
				{mode === "output" && processes.length > 0 && (
					<text fg={colors.fgDim}>
						{processes.length > 1
							? "Left/Right: tabs | Esc: kill | Tab: switch panel"
							: "Esc: kill process | Tab: switch panel"}
					</text>
				)}
			</box>
		</box>
	);
}
