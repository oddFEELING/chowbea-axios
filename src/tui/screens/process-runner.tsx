/**
 * Process Runner screen — tabbed process management with a searchable
 * script palette. Each tab is either an empty palette (select a script)
 * or a full-screen log viewer (process output). Tab and process state
 * persists across screen navigation via module-level singletons.
 */

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { useKeyboard } from "@opentui/react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "../../core/config.js";
import { processManager } from "../services/process-manager.js";
import { tabStore } from "../services/tab-store.js";
import { TabBar } from "../components/tab-bar.js";
import { ScriptPalette, type ScriptEntry } from "../components/script-palette.js";
import { LogViewer } from "../components/log-viewer.js";

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

interface ProcessScreenProps {
	setInputMode?: (v: boolean) => void;
}

export function ProcessScreen({ setInputMode }: ProcessScreenProps) {
	const [scripts, setScripts] = useState<ScriptEntry[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [projectRoot, setProjectRoot] = useState<string>("");

	// Subscribe to singletons
	const processes = useSyncExternalStore(
		(cb) => processManager.subscribe(cb),
		() => processManager.getProcesses(),
	);

	const tabSnapshot = useSyncExternalStore(
		(cb) => tabStore.subscribe(cb),
		() => tabStore.getSnapshot(),
	);

	const activeTab = tabSnapshot.tabs.find(
		(t) => t.id === tabSnapshot.activeTabId,
	);
	const activeProcess = activeTab?.processId
		? processes.find((p) => p.id === activeTab.processId)
		: undefined;

	// ------------------------------------------------------------------
	// Load scripts from package.json
	// ------------------------------------------------------------------
	const loadScripts = useCallback(async () => {
		try {
			const root = projectRoot || (await findProjectRoot());
			if (!projectRoot) setProjectRoot(root);

			const raw = await readFile(join(root, "package.json"), "utf8");
			const pkg = JSON.parse(raw) as {
				scripts?: Record<string, string>;
			};
			const entries: ScriptEntry[] = Object.entries(pkg.scripts ?? {})
				.filter(([name]) => !INTERNAL_SCRIPTS.has(name))
				.map(([name, command]) => ({ name, command }));

			setScripts((prev) => {
				const prevKey = prev
					.map((s) => `${s.name}=${s.command}`)
					.join("|");
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

	useEffect(() => {
		void loadScripts();
	}, [loadScripts]);

	useEffect(() => {
		const interval = setInterval(() => {
			void loadScripts();
		}, SCRIPT_REFRESH_MS);
		return () => clearInterval(interval);
	}, [loadScripts]);

	// ------------------------------------------------------------------
	// Handlers
	// ------------------------------------------------------------------
	const handleRunScript = useCallback(
		(entry: ScriptEntry) => {
			if (!projectRoot || !activeTab) return;
			const processId = processManager.run(entry, projectRoot);
			tabStore.attachProcess(activeTab.id, processId, entry.name);
		},
		[projectRoot, activeTab],
	);

	const handleCloseTab = useCallback(() => {
		if (!activeTab) return;
		if (activeTab.processId) {
			const proc = processes.find((p) => p.id === activeTab.processId);
			if (proc?.status === "running") {
				processManager.kill(proc.id);
			}
			processManager.remove(activeTab.processId);
		}
		tabStore.closeTab(activeTab.id);
	}, [activeTab, processes]);

	const handleInputFocusChange = useCallback(
		(focused: boolean) => {
			setInputMode?.(focused);
		},
		[setInputMode],
	);

	// ------------------------------------------------------------------
	// Keyboard — tab management and process controls
	// ------------------------------------------------------------------
	useKeyboard((key) => {
		// Ctrl+T — new tab
		if (key.name === "t" && key.ctrl) {
			tabStore.addTab();
			return;
		}

		// Ctrl+W — close current tab
		if (key.name === "w" && key.ctrl) {
			if (!activeTab) return;
			// Kill running process first
			if (activeTab.processId) {
				const proc = processes.find(
					(p) => p.id === activeTab.processId,
				);
				if (proc?.status === "running") {
					processManager.kill(proc.id);
				}
				processManager.remove(activeTab.processId);
			}
			tabStore.closeTab(activeTab.id);
			return;
		}

		// Left/Right — switch tabs (always available)
		if (key.name === "left") {
			tabStore.prevTab();
			return;
		}
		if (key.name === "right") {
			tabStore.nextTab();
			return;
		}

		// When in palette mode (no active process), let ScriptPalette handle other keys
		if (!activeTab?.processId) {
			return;
		}

		// Below: only when log viewer is active (has a process)
		if (!activeTab?.processId || !activeProcess) return;

		// Escape / Ctrl+C — kill running process
		if (
			key.name === "escape" ||
			(key.name === "c" && key.ctrl)
		) {
			if (activeProcess.status === "running") {
				processManager.kill(activeProcess.id);
			}
			return;
		}

		// Ctrl+R — re-run same script
		if (key.name === "r" && key.ctrl) {
			if (
				activeProcess.status !== "running" &&
				projectRoot
			) {
				processManager.remove(activeProcess.id);
				const newId = processManager.run(
					{
						name: activeProcess.name,
						command: activeProcess.command,
					},
					projectRoot,
				);
				tabStore.attachProcess(activeTab.id, newId, activeProcess.name);
			}
			return;
		}
	});

	// ------------------------------------------------------------------
	// Render
	// ------------------------------------------------------------------
	if (loadError) {
		return (
			<box flexDirection="column" gap={1} padding={1}>
				<text fg="#f7768e">{`Error: ${loadError}`}</text>
			</box>
		);
	}

	return (
		<box flexDirection="column" flexGrow={1}>
			{/* Tab bar */}
			<TabBar
				tabs={tabSnapshot.tabs}
				activeTabId={tabSnapshot.activeTabId}
				processes={processes}
			/>

			{/* Separator */}
			<box paddingX={1}>
				<text fg="#414868">
					{"\u2501".repeat(70)}
				</text>
			</box>

			{/* Content: palette or log viewer */}
			{activeTab && !activeTab.processId ? (
				<ScriptPalette
					scripts={scripts}
					onRun={handleRunScript}
					onClose={handleCloseTab}
					canClose={tabSnapshot.tabs.length > 1}
					onInputFocusChange={handleInputFocusChange}
				/>
			) : activeProcess ? (
				<LogViewer process={activeProcess} focused />
			) : (
				<box
					flexDirection="column"
					flexGrow={1}
					justifyContent="center"
					alignItems="center"
				>
					<text fg="#565f89">Loading...</text>
				</box>
			)}
		</box>
	);
}
