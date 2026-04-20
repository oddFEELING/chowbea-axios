/**
 * Plugins Manager screen -- browse and inspect Vite codegen plugin surfaces
 * and side-panels.  Tabbed three-panel layout: search bar, scrollable grouped
 * list, and a detail pane with bordered metadata cards.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme/colors.js";
import { createTuiLogger } from "../adapters/tui-logger.js";
import {
	executePluginsScan,
	type PluginsResult,
	type SurfaceInfo,
	type PanelInfo,
} from "../../core/actions/plugins.js";
import {
	setupVitePlugins,
	type PromptProvider,
} from "../../core/actions/init.js";
import { findProjectRoot } from "../../core/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActiveTab = "surfaces" | "panels";
type FocusPanel = "search" | "list" | "detail";

interface TabState {
	searchQuery: string;
	selectedIndex: number;
	scrollOffset: number;
	focusPanel: FocusPanel;
}

type ListItem = SurfaceInfo | PanelInfo;

type ListRow =
	| { type: "group-header"; group: string }
	| { type: "item"; item: ListItem; index: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a flat ListRow array from items sorted by group then name. */
function buildListRows(items: ListItem[]): ListRow[] {
	const sorted = [...items].sort((a, b) => {
		const gc = a.group.localeCompare(b.group);
		if (gc !== 0) return gc;
		return a.id.localeCompare(b.id);
	});

	const rows: ListRow[] = [];
	let lastGroup: string | null = null;
	let itemIndex = 0;

	for (const item of sorted) {
		if (item.group !== lastGroup) {
			rows.push({ type: "group-header", group: item.group });
			lastGroup = item.group;
		}
		rows.push({ type: "item", item, index: itemIndex });
		itemIndex++;
	}

	return rows;
}

/** Filter items by search query. Supports `g:groupname` prefix. */
function filterItems(items: ListItem[], query: string): ListItem[] {
	if (!query) return items;

	// g: prefix filters by group
	if (query.startsWith("g:")) {
		const groupQuery = query.slice(2).trim().toLowerCase();
		if (!groupQuery) return items;
		return items.filter((item) =>
			item.group.toLowerCase().includes(groupQuery),
		);
	}

	const q = query.toLowerCase();
	return items.filter(
		(item) =>
			item.id.toLowerCase().includes(q) ||
			item.group.toLowerCase().includes(q) ||
			item.filePath.toLowerCase().includes(q) ||
			item.constName.toLowerCase().includes(q),
	);
}

/** Get the next selectable item index in the given direction, skipping group headers. */
function findNextSelectableIndex(
	rows: ListRow[],
	currentIndex: number,
	direction: "up" | "down",
): number {
	const step = direction === "up" ? -1 : 1;
	// Find current row position from item index
	const currentRowPos = rows.findIndex(
		(r) => r.type === "item" && r.index === currentIndex,
	);
	if (currentRowPos === -1) return currentIndex;

	let pos = currentRowPos + step;
	while (pos >= 0 && pos < rows.length) {
		const row = rows[pos];
		if (row && row.type === "item") return row.index;
		pos += step;
	}
	return currentIndex;
}

// ---------------------------------------------------------------------------
// Setup wizard types
// ---------------------------------------------------------------------------

type PluginChoice = "both" | "surfaces" | "sidepanels";

interface SetupValues {
	pluginChoice: PluginChoice;
	importPrefix: string;
	surfacesDir: string;
	sidepanelsDir: string;
}

const SETUP_DEFAULTS: SetupValues = {
	pluginChoice: "both",
	importPrefix: "@/",
	surfacesDir: "src/components/surfaces",
	sidepanelsDir: "src/components/side-panels",
};

type SetupPhase = "idle" | "choosing" | "prefix" | "surfacesDir" | "sidepanelsDir" | "running" | "done" | "error";

const PLUGIN_CHOICES: Array<{ name: string; value: PluginChoice }> = [
	{ name: "Both (Surfaces + Side Panels)", value: "both" },
	{ name: "Surfaces only (modal dialogs / drawers)", value: "surfaces" },
	{ name: "Side Panels only (slide-out panels)", value: "sidepanels" },
];

/** Build a PromptProvider that replays setup wizard values into setupVitePlugins. */
function buildSetupReplayProvider(values: SetupValues): PromptProvider {
	let selectCalls = 0;
	let inputCalls = 0;

	return {
		async select() {
			selectCalls++;
			// First select is plugin choice
			return values.pluginChoice as any;
		},
		async input(opts) {
			inputCalls++;
			if (inputCalls === 1) return values.importPrefix;
			if (inputCalls === 2) return values.surfacesDir;
			if (inputCalls === 3) return values.sidepanelsDir;
			return opts.default ?? "";
		},
		async confirm() {
			return true;
		},
		async password() {
			return "";
		},
		async checkbox() {
			return [];
		},
	};
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PluginsScreen({ setInputMode }: { setInputMode?: (v: boolean) => void }) {
	const [data, setData] = useState<PluginsResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<ActiveTab>("surfaces");

	// Setup wizard state
	const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
	const [setupValues, setSetupValues] = useState<SetupValues>(SETUP_DEFAULTS);
	const [setupChoiceIndex, setSetupChoiceIndex] = useState(0);
	const [setupLogs, setSetupLogs] = useState<string[]>([]);
	const [setupError, setSetupError] = useState<string | null>(null);
	const setupInputRef = useRef("");

	// Independent tab states
	const [surfacesState, setSurfacesState] = useState<TabState>({
		searchQuery: "",
		selectedIndex: 0,
		scrollOffset: 0,
		focusPanel: "list",
	});
	const [panelsState, setPanelsState] = useState<TabState>({
		searchQuery: "",
		selectedIndex: 0,
		scrollOffset: 0,
		focusPanel: "list",
	});

	const tabState = activeTab === "surfaces" ? surfacesState : panelsState;
	const setTabState = activeTab === "surfaces" ? setSurfacesState : setPanelsState;

	// Notify parent when search input or setup text input is focused
	const isInputActive = tabState.focusPanel === "search" ||
		setupPhase === "prefix" || setupPhase === "surfacesDir" || setupPhase === "sidepanelsDir";
	useEffect(() => {
		setInputMode?.(isInputActive);
		return () => setInputMode?.(false);
	}, [isInputActive, setInputMode]);

	// Terminal height for dynamic visible rows
	const { height: termHeight } = useTerminalDimensions();
	const visibleRows = Math.max(10, termHeight - 15);

	// ------------------------------------------------------------------
	// Load data (on mount and after setup)
	// ------------------------------------------------------------------
	const loadData = useCallback(() => {
		setLoading(true);
		const { logger } = createTuiLogger("warn");
		executePluginsScan({}, logger)
			.then((result: PluginsResult) => {
				setData(result);
			})
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
			})
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	// ------------------------------------------------------------------
	// Run setup wizard
	// ------------------------------------------------------------------
	const runSetup = useCallback(async (values: SetupValues) => {
		setSetupPhase("running");
		setSetupLogs([]);
		setSetupError(null);

		try {
			const projectRoot = await findProjectRoot();
			const { logger, getLogs } = createTuiLogger("info");

			const prompts = buildSetupReplayProvider(values);
			await setupVitePlugins(projectRoot, false, logger, prompts);

			setSetupLogs(getLogs().map((l) => l.message));
			setSetupPhase("done");
			// Reload data after setup
			loadData();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			setSetupError(msg);
			setSetupPhase("error");
		}
	}, [loadData]);

	// ------------------------------------------------------------------
	// Filtered items and list rows
	// ------------------------------------------------------------------
	const items: ListItem[] = useMemo(() => {
		if (!data) return [];
		return activeTab === "surfaces" ? data.surfaces : data.panels;
	}, [data, activeTab]);

	const filtered = useMemo(
		() => filterItems(items, tabState.searchQuery),
		[items, tabState.searchQuery],
	);

	const listRows = useMemo(() => buildListRows(filtered), [filtered]);

	// The sorted items list (in the same order as listRows)
	const sortedItems = useMemo(
		() => listRows.filter((r): r is Extract<ListRow, { type: "item" }> => r.type === "item"),
		[listRows],
	);

	const selectedItem = sortedItems.find((r) => r.index === tabState.selectedIndex)?.item;

	// Reset selection when filter or tab changes
	useEffect(() => {
		setTabState((prev) => ({
			...prev,
			selectedIndex: 0,
			scrollOffset: 0,
		}));
	}, [tabState.searchQuery, activeTab]);

	// ------------------------------------------------------------------
	// Keyboard — setup wizard
	// ------------------------------------------------------------------
	useKeyboard((key) => {
		// Handle setup wizard keyboard when active
		if (setupPhase === "choosing") {
			if (key.name === "up") {
				setSetupChoiceIndex((i) => Math.max(0, i - 1));
				return;
			}
			if (key.name === "down") {
				setSetupChoiceIndex((i) => Math.min(PLUGIN_CHOICES.length - 1, i + 1));
				return;
			}
			if (key.name === "return") {
				const chosen = PLUGIN_CHOICES[setupChoiceIndex];
				if (chosen) {
					setSetupValues((prev) => ({ ...prev, pluginChoice: chosen.value }));
					setSetupPhase("prefix");
					setupInputRef.current = SETUP_DEFAULTS.importPrefix;
				}
				return;
			}
			if (key.name === "escape") {
				setSetupPhase("idle");
				return;
			}
			return;
		}

		if (setupPhase === "prefix" || setupPhase === "surfacesDir" || setupPhase === "sidepanelsDir") {
			// These phases use the <input> component — only handle Enter/Escape
			if (key.name === "return") {
				const val = setupInputRef.current.trim();
				if (setupPhase === "prefix") {
					setSetupValues((prev) => ({ ...prev, importPrefix: val || "@/" }));
					const needsSurfaces = setupValues.pluginChoice === "both" || setupValues.pluginChoice === "surfaces";
					if (needsSurfaces) {
						setSetupPhase("surfacesDir");
						setupInputRef.current = SETUP_DEFAULTS.surfacesDir;
					} else {
						setSetupPhase("sidepanelsDir");
						setupInputRef.current = SETUP_DEFAULTS.sidepanelsDir;
					}
				} else if (setupPhase === "surfacesDir") {
					setSetupValues((prev) => ({ ...prev, surfacesDir: val || SETUP_DEFAULTS.surfacesDir }));
					const needsPanels = setupValues.pluginChoice === "both" || setupValues.pluginChoice === "sidepanels";
					if (needsPanels) {
						setSetupPhase("sidepanelsDir");
						setupInputRef.current = SETUP_DEFAULTS.sidepanelsDir;
					} else {
						runSetup({ ...setupValues, surfacesDir: val || SETUP_DEFAULTS.surfacesDir });
					}
				} else if (setupPhase === "sidepanelsDir") {
					const finalValues = { ...setupValues, sidepanelsDir: val || SETUP_DEFAULTS.sidepanelsDir };
					runSetup(finalValues);
				}
				return;
			}
			if (key.name === "escape") {
				setSetupPhase("idle");
				return;
			}
			return;
		}

		if (setupPhase === "done" || setupPhase === "error") {
			// Any key dismisses
			if (key.name === "return" || key.name === "escape") {
				setSetupPhase("idle");
				return;
			}
			return;
		}

		if (setupPhase === "running") {
			return; // Ignore all keys while running
		}

		// Normal mode keyboard below
		// ------------------------------------------------------------------

		// [ / ] switches tabs
		if (key.raw === "[") {
			setActiveTab("surfaces");
			return;
		}
		if (key.raw === "]") {
			setActiveTab("panels");
			return;
		}

		// `/` focuses the search bar from anywhere
		if (key.raw === "/" && tabState.focusPanel !== "search") {
			setTabState((prev) => ({ ...prev, focusPanel: "search" }));
			return;
		}

		// Tab cycles panels
		if (key.name === "tab") {
			setTabState((prev) => ({
				...prev,
				focusPanel:
					prev.focusPanel === "search"
						? "list"
						: prev.focusPanel === "list"
							? "detail"
							: "search",
			}));
			return;
		}

		// Escape context-dependent
		if (key.name === "escape") {
			if (tabState.focusPanel === "search" && tabState.searchQuery) {
				setTabState((prev) => ({ ...prev, searchQuery: "" }));
				return;
			}
			if (tabState.focusPanel === "search") {
				setTabState((prev) => ({ ...prev, focusPanel: "list" }));
				return;
			}
			if (tabState.focusPanel === "detail") {
				setTabState((prev) => ({ ...prev, focusPanel: "list" }));
				return;
			}
			return;
		}

		// Enter context-dependent
		if (key.name === "return") {
			if (tabState.focusPanel === "search") {
				setTabState((prev) => ({ ...prev, focusPanel: "list" }));
				return;
			}
			if (tabState.focusPanel === "list") {
				setTabState((prev) => ({ ...prev, focusPanel: "detail" }));
				return;
			}
			return;
		}

		// `s` launches setup wizard (from any panel)
		if (key.raw === "s" && tabState.focusPanel !== "search") {
			setSetupPhase("choosing");
			setSetupChoiceIndex(0);
			setSetupValues(SETUP_DEFAULTS);
			return;
		}

		// Up / Down navigation in list panel (skipping group headers)
		if (tabState.focusPanel === "list") {
			if (key.name === "up") {
				setTabState((prev) => {
					const next = findNextSelectableIndex(listRows, prev.selectedIndex, "up");
					const newOffset = next < prev.scrollOffset ? next : prev.scrollOffset;
					return { ...prev, selectedIndex: next, scrollOffset: newOffset };
				});
			}
			if (key.name === "down") {
				setTabState((prev) => {
					const next = findNextSelectableIndex(listRows, prev.selectedIndex, "down");
					const newOffset =
						next >= prev.scrollOffset + visibleRows
							? next - visibleRows + 1
							: prev.scrollOffset;
					return { ...prev, selectedIndex: next, scrollOffset: newOffset };
				});
			}
		}
	});

	// ------------------------------------------------------------------
	// Search handler
	// ------------------------------------------------------------------
	const handleSearch = useCallback(
		(value: string) => {
			setTabState((prev) => ({ ...prev, searchQuery: value }));
		},
		[setTabState],
	);

	// ------------------------------------------------------------------
	// Render helpers
	// ------------------------------------------------------------------

	function renderListRow(row: ListRow, isSelected: boolean) {
		if (row.type === "group-header") {
			const label = row.group || "(root)";
			return (
				<box key={`gh-${row.group}`} height={1}>
					<text fg={colors.fgDim}>
						{`  ${label}/`}
					</text>
				</box>
			);
		}

		const item = row.item;
		return (
			<box key={`item-${item.id}`} flexDirection="row" height={1}>
				<text fg={isSelected ? colors.accent : colors.fgDim}>
					{isSelected ? "\u25b6 " : "  "}
				</text>
				<text
					fg={
						isSelected
							? colors.fgBright
							: colors.fg
					}
				>
					{item.id}
				</text>
			</box>
		);
	}

	function renderSurfaceDetail(surface: SurfaceInfo) {
		return (
			<box flexDirection="column" gap={1}>
				<box
					border
					borderColor={colors.accent}
					paddingX={2}
					paddingY={1}
					flexDirection="column"
					gap={1}
				>
					{/* ID */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>ID</text>
						<text fg={colors.fgBright}>{surface.id}</text>
					</box>

					{/* Variant */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Variant</text>
						<text
							fg={surface.variant === "alert" ? colors.warning : colors.info}
						>
							{surface.variant}
						</text>
					</box>

					{/* Close on action */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Close on action</text>
						<text fg={surface.closeOnAction ? colors.success : colors.fgDim}>
							{surface.closeOnAction ? "yes" : "no"}
						</text>
					</box>

					{/* Default props */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Default props</text>
						<text fg={colors.accentAlt}>
							{surface.defaultProps.length > 0
								? surface.defaultProps.join(", ")
								: "(none)"}
						</text>
					</box>

					{/* Group */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Group</text>
						<text fg={colors.fg}>
							{surface.group || "(root)"}
						</text>
					</box>

					{/* File path */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>File</text>
						<text fg={colors.fg}>{surface.filePath}</text>
					</box>
				</box>
			</box>
		);
	}

	function renderPanelDetail(panel: PanelInfo) {
		return (
			<box flexDirection="column" gap={1}>
				<box
					border
					borderColor={colors.accent}
					paddingX={2}
					paddingY={1}
					flexDirection="column"
					gap={1}
				>
					{/* ID */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>ID</text>
						<text fg={colors.fgBright}>{panel.id}</text>
					</box>

					{/* Context params */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Context params</text>
						<text fg={colors.accentAlt}>
							{panel.contextParams.length > 0
								? panel.contextParams.join(", ")
								: "(none)"}
						</text>
					</box>

					{/* Route params */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Route params</text>
						<text fg={colors.accentAlt}>
							{panel.routeParams.length > 0
								? panel.routeParams.join(", ")
								: "(none)"}
						</text>
					</box>

					{/* Group */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>Group</text>
						<text fg={colors.fg}>
							{panel.group || "(root)"}
						</text>
					</box>

					{/* File path */}
					<box flexDirection="row" gap={1}>
						<text fg={colors.fgDim}>File</text>
						<text fg={colors.fg}>{panel.filePath}</text>
					</box>
				</box>
			</box>
		);
	}

	// ------------------------------------------------------------------
	// Render: loading / error / not-configured states
	// ------------------------------------------------------------------

	if (loading) {
		return (
			<box
				flexDirection="column"
				flexGrow={1}
				justifyContent="center"
				alignItems="center"
			>
				<text fg={colors.fgDim}>
					Loading plugins...
				</text>
			</box>
		);
	}

	if (error) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>Plugins Manager</text>
				<text fg={colors.error}>{`Error: ${error}`}</text>
			</box>
		);
	}

	// ------------------------------------------------------------------
	// Render: setup wizard overlay (shown on top of any state)
	// ------------------------------------------------------------------
	const renderSetupWizard = () => {
		if (setupPhase === "idle") return null;

		if (setupPhase === "choosing") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.fg}>Which codegen plugins would you like to set up?</text>
					<text fg={colors.fgDim}>{""}</text>
					{PLUGIN_CHOICES.map((choice, i) => (
						<text
							key={choice.value}
							fg={i === setupChoiceIndex ? colors.accent : colors.fg}
						>
							{`${i === setupChoiceIndex ? "\u25b6 " : "  "}${choice.name}`}
						</text>
					))}
					<text fg={colors.fgDim}>{""}</text>
					<text fg={colors.fgDim}>Up/Down select | Enter confirm | Esc cancel</text>
				</box>
			);
		}

		if (setupPhase === "prefix") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.fg}>What import alias does your project use?</text>
					<box
						border
						borderColor={colors.borderFocus}
						paddingX={1}
						height={3}
					>
						<input
							placeholder="@/"
							onInput={(v: string) => { setupInputRef.current = v; }}
							focused={true}
							textColor={colors.fg}
							backgroundColor={colors.bg}
						/>
					</box>
					<text fg={colors.fgDim}>Enter confirm | Esc cancel</text>
				</box>
			);
		}

		if (setupPhase === "surfacesDir") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.fg}>Surfaces directory (relative to project root):</text>
					<box
						border
						borderColor={colors.borderFocus}
						paddingX={1}
						height={3}
					>
						<input
							placeholder="src/components/surfaces"
							onInput={(v: string) => { setupInputRef.current = v; }}
							focused={true}
							textColor={colors.fg}
							backgroundColor={colors.bg}
						/>
					</box>
					<text fg={colors.fgDim}>Enter confirm | Esc cancel</text>
				</box>
			);
		}

		if (setupPhase === "sidepanelsDir") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.fg}>Side panels directory (relative to project root):</text>
					<box
						border
						borderColor={colors.borderFocus}
						paddingX={1}
						height={3}
					>
						<input
							placeholder="src/components/side-panels"
							onInput={(v: string) => { setupInputRef.current = v; }}
							focused={true}
							textColor={colors.fg}
							backgroundColor={colors.bg}
						/>
					</box>
					<text fg={colors.fgDim}>Enter confirm | Esc cancel</text>
				</box>
			);
		}

		if (setupPhase === "running") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.fgDim}>Setting up plugins...</text>
				</box>
			);
		}

		if (setupPhase === "done") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.success}>Setup complete!</text>
					{setupLogs.map((log, i) => (
						<text key={i} fg={colors.fgDim}>{`  ${log}`}</text>
					))}
					<text fg={colors.fgDim}>{""}</text>
					<text fg={colors.fgDim}>Press Enter to continue</text>
				</box>
			);
		}

		if (setupPhase === "error") {
			return (
				<box flexDirection="column" gap={1}>
					<text fg={colors.accent}>Plugin Setup</text>
					<text fg={colors.error}>{`Error: ${setupError}`}</text>
					<text fg={colors.fgDim}>Press Enter to dismiss</text>
				</box>
			);
		}

		return null;
	};

	// If setup wizard is active, render it instead of the main screen
	const setupOverlay = renderSetupWizard();
	if (setupOverlay) return setupOverlay;

	// ------------------------------------------------------------------
	// Render: not-configured state (with inline setup action)
	// ------------------------------------------------------------------
	if (data && !data.surfacesConfigured && !data.sidepanelsConfigured) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>Plugins Manager</text>
				<text fg={colors.fg}>
					Vite plugins are not configured yet.
				</text>
				<text fg={colors.fgDim}>{""}</text>
				<box flexDirection="row">
					<text fg={colors.fg}>{"Press "}</text>
					<text fg={colors.accent}>{"s"}</text>
					<text fg={colors.fg}>{" to run the setup wizard."}</text>
				</box>
			</box>
		);
	}

	// ------------------------------------------------------------------
	// Main layout
	// ------------------------------------------------------------------

	// Compute visible list rows for scroll window
	const visibleListRows = listRows.slice(
		tabState.scrollOffset,
		tabState.scrollOffset + visibleRows,
	);
	const hasMoreAbove = tabState.scrollOffset > 0;
	const hasMoreBelow = tabState.scrollOffset + visibleRows < listRows.length;

	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			{/* Title row with tabs */}
			<box flexDirection="row" gap={2}>
				<text fg={colors.accent}>Plugins Manager</text>
				<text
					fg={activeTab === "surfaces" ? colors.fgBright : colors.fgDim}
					bg={activeTab === "surfaces" ? colors.bgHighlight : undefined}
				>
					{" Surfaces "}
				</text>
				<text
					fg={activeTab === "panels" ? colors.fgBright : colors.fgDim}
					bg={activeTab === "panels" ? colors.bgHighlight : undefined}
				>
					{" Panels "}
				</text>
				<text fg={colors.fgDim}>
					{`${filtered.length}/${items.length}`}
				</text>
			</box>

			{/* Search bar */}
			<box
				border
				borderColor={
					tabState.focusPanel === "search"
						? colors.borderFocus
						: colors.border
				}
				paddingX={1}
				height={3}
			>
				<input
					placeholder="/ Search by name, id, group, path  g:group filter"
					onInput={handleSearch}
					focused={tabState.focusPanel === "search"}
					textColor={colors.fg}
					backgroundColor={colors.bg}
				/>
			</box>

			{/* Main: list + detail side by side */}
			<box flexDirection="row" flexGrow={1} gap={1}>
				{/* Left: grouped list */}
				<box
					border
					borderColor={
						tabState.focusPanel === "list"
							? colors.borderFocus
							: colors.border
					}
					paddingX={1}
					flexDirection="column"
					width="35%"
					flexGrow={0}
					flexShrink={0}
				>
					{listRows.length > 0 ? (
						<box flexDirection="column" flexGrow={1}>
							{hasMoreAbove && (
								<text fg={colors.fgDim}>
									{`  \u25b2 ${tabState.scrollOffset} more`}
								</text>
							)}
							{visibleListRows.map((row) =>
								renderListRow(
									row,
									row.type === "item" && row.index === tabState.selectedIndex,
								),
							)}
							{hasMoreBelow && (
								<text fg={colors.fgDim}>
									{`  \u25bc ${listRows.length - tabState.scrollOffset - visibleRows} more`}
								</text>
							)}
						</box>
					) : (
						<text fg={colors.fgDim}>
							No matching items
						</text>
					)}
				</box>

				{/* Right: detail */}
				<box
					border
					borderColor={
						tabState.focusPanel === "detail"
							? colors.borderFocus
							: colors.border
					}
					paddingX={1}
					flexDirection="column"
					flexGrow={1}
				>
					<scrollbox
						focused={tabState.focusPanel === "detail"}
						flexGrow={1}
					>
						{selectedItem ? (
							activeTab === "surfaces" ? (
								renderSurfaceDetail(selectedItem as SurfaceInfo)
							) : (
								renderPanelDetail(selectedItem as PanelInfo)
							)
						) : (
							<text fg={colors.fgDim}>
								Select an item
							</text>
						)}
					</scrollbox>
				</box>
			</box>

			{/* Keyboard hint */}
			<text fg={colors.fgDim}>
				{
					"/ search | Tab panel | [ ] switch tab | \u2191\u2193 nav | Enter select | s setup | Esc back"
				}
			</text>
		</box>
	);
}
