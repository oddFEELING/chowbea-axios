/**
 * Env Manager screen — browse, edit, and compare .env files across
 * environments with .env.example as the source-of-truth blueprint.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme/colors.js";
import { findProjectRoot } from "../../core/config.js";
import {
	detectEnvFiles,
	compareWithBlueprint,
	createBlueprintFromEnv,
	addVarToFile,
	removeVarFromFile,
	updateVarInFile,
	type EnvFile,
	type MissingVarSummary,
} from "../../core/actions/env-manager.js";

type Panel = "envs" | "vars";
type EditMode = "none" | "edit-value" | "add-key" | "add-value" | "new-env" | "confirm-delete" | "search";

interface EnvManagerProps {
	setInputMode?: (v: boolean) => void;
}

export function EnvManagerScreen({ setInputMode }: EnvManagerProps) {
	const [projectRoot, setProjectRoot] = useState("");
	const [envFiles, setEnvFiles] = useState<EnvFile[]>([]);
	const [selectedEnvIdx, setSelectedEnvIdx] = useState(0);
	const [selectedVarIdx, setSelectedVarIdx] = useState(0);
	const [panel, setPanel] = useState<Panel>("envs");
	const [secretsHidden, setSecretsHidden] = useState(true);
	const [editMode, setEditMode] = useState<EditMode>("none");
	const [editBuffer, setEditBuffer] = useState("");
	const [newKeyBuffer, setNewKeyBuffer] = useState("");
	const [searchQuery, setSearchQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [gitignoreWarnings, setGitignoreWarnings] = useState<string[]>([]);

	const { height: termHeight } = useTerminalDimensions();

	// Derived state — all env files are selectable (including .env.example)
	const blueprint = useMemo(
		() => envFiles.find((f) => f.name === "example"),
		[envFiles],
	);
	const environments = envFiles;
	const selectedEnv = environments[selectedEnvIdx] as EnvFile | undefined;

	// Don't compare blueprint to itself
	const isBlueprint = selectedEnv?.name === "example";

	const comparison = useMemo<MissingVarSummary | null>(() => {
		if (!blueprint || !selectedEnv || isBlueprint) return null;
		return compareWithBlueprint(blueprint, selectedEnv);
	}, [blueprint, selectedEnv, isBlueprint]);

	// Combined var list: env vars + missing from blueprint, filtered by search
	const displayVars = useMemo(() => {
		if (!selectedEnv) return [];
		const existing = selectedEnv.vars.map((v) => ({
			key: v.key,
			value: v.value,
			status: (!isBlueprint && blueprint)
				? blueprint.vars.some((bv) => bv.key === v.key)
					? ("ok" as const)
					: ("extra" as const)
				: ("ok" as const),
		}));
		const missing = (comparison?.missingFromEnv ?? []).map((key) => ({
			key,
			value: null as string | null,
			status: "missing" as const,
		}));
		const all = [...existing, ...missing];

		// Filter by search query
		if (!searchQuery) return all;
		const q = searchQuery.toLowerCase();
		return all.filter(
			(v) =>
				v.key.toLowerCase().includes(q) ||
				(v.value !== null && v.value.toLowerCase().includes(q)),
		);
	}, [selectedEnv, blueprint, comparison, isBlueprint, searchQuery]);

	// Notify parent about input focus
	useEffect(() => {
		const isInput = editMode !== "none" && editMode !== "confirm-delete";
		setInputMode?.(isInput);
		return () => setInputMode?.(false);
	}, [editMode, setInputMode]);

	// Reset var selection when search changes
	useEffect(() => {
		setSelectedVarIdx(0);
	}, [searchQuery]);

	// ------------------------------------------------------------------
	// Load env files
	// ------------------------------------------------------------------
	const loadEnvFiles = useCallback(async () => {
		try {
			const root = projectRoot || (await findProjectRoot());
			if (!projectRoot) setProjectRoot(root);

			const files = await detectEnvFiles(root);
			setEnvFiles(files);

			// Check gitignore
			const { isGitignored } = await import(
				"../../core/actions/env-manager.js"
			);
			const warnings: string[] = [];
			for (const f of files) {
				if (f.name === "example") continue;
				const ignored = await isGitignored(root, f.filename);
				if (!ignored) warnings.push(f.filename);
			}
			setGitignoreWarnings(warnings);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [projectRoot]);

	useEffect(() => {
		void loadEnvFiles();
	}, [loadEnvFiles]);

	// ------------------------------------------------------------------
	// Actions
	// ------------------------------------------------------------------
	const handleCreateBlueprint = useCallback(async () => {
		if (!projectRoot || environments.length === 0) return;
		const source = environments[0]!;
		await createBlueprintFromEnv(source, projectRoot);
		await loadEnvFiles();
	}, [projectRoot, environments, loadEnvFiles]);

	const handleSaveEdit = useCallback(async () => {
		if (!selectedEnv) return;
		const varEntry = displayVars[selectedVarIdx];
		if (!varEntry) return;

		if (editMode === "edit-value") {
			await updateVarInFile(selectedEnv.path, varEntry.key, editBuffer);
		}
		setEditMode("none");
		setEditBuffer("");
		await loadEnvFiles();
	}, [selectedEnv, displayVars, selectedVarIdx, editMode, editBuffer, loadEnvFiles]);

	const handleAddVar = useCallback(async () => {
		if (!selectedEnv || !newKeyBuffer.trim()) return;
		await addVarToFile(selectedEnv.path, newKeyBuffer.trim(), editBuffer);

		// Offer to add to blueprint too
		if (blueprint) {
			const bpHasKey = blueprint.vars.some((v) => v.key === newKeyBuffer.trim());
			if (!bpHasKey) {
				await addVarToFile(blueprint.path, newKeyBuffer.trim(), "");
			}
		}

		setEditMode("none");
		setNewKeyBuffer("");
		setEditBuffer("");
		await loadEnvFiles();
	}, [selectedEnv, blueprint, newKeyBuffer, editBuffer, loadEnvFiles]);

	const handleDeleteVar = useCallback(async () => {
		if (!selectedEnv) return;
		const varEntry = displayVars[selectedVarIdx];
		if (!varEntry || varEntry.status === "missing") return;
		await removeVarFromFile(selectedEnv.path, varEntry.key);
		setEditMode("none");
		setSelectedVarIdx((prev) => Math.max(0, prev - 1));
		await loadEnvFiles();
	}, [selectedEnv, displayVars, selectedVarIdx, loadEnvFiles]);

	const handleCreateEnv = useCallback(async () => {
		if (!projectRoot || !editBuffer.trim()) return;
		const filename = `.env.${editBuffer.trim()}`;
		const filePath = `${projectRoot}/${filename}`;

		// Create with blueprint keys if available
		if (blueprint) {
			const vars = blueprint.vars.map((v) => ({
				key: v.key,
				value: "",
			}));
			const { writeEnvFile } = await import(
				"../../core/actions/env-manager.js"
			);
			await writeEnvFile(filePath, vars);
		} else {
			const { writeFile } = await import("node:fs/promises");
			await writeFile(filePath, "# Environment variables\n", "utf8");
		}

		setEditMode("none");
		setEditBuffer("");
		await loadEnvFiles();
	}, [projectRoot, blueprint, editBuffer, loadEnvFiles]);

	// ------------------------------------------------------------------
	// Keyboard
	// ------------------------------------------------------------------
	useKeyboard((key) => {
		// Handle edit modes
		if (editMode === "confirm-delete") {
			if (key.name === "return" || key.raw === "y") {
				void handleDeleteVar();
			} else {
				setEditMode("none");
			}
			return;
		}

		if (editMode === "edit-value") {
			if (key.name === "return") {
				void handleSaveEdit();
			} else if (key.name === "escape") {
				setEditMode("none");
				setEditBuffer("");
			}
			return;
		}

		if (editMode === "add-key") {
			if (key.name === "return" && newKeyBuffer.trim()) {
				setEditMode("add-value");
			} else if (key.name === "escape") {
				setEditMode("none");
				setNewKeyBuffer("");
			}
			return;
		}

		if (editMode === "add-value") {
			if (key.name === "return") {
				void handleAddVar();
			} else if (key.name === "escape") {
				setEditMode("none");
				setNewKeyBuffer("");
				setEditBuffer("");
			}
			return;
		}

		if (editMode === "new-env") {
			if (key.name === "return" && editBuffer.trim()) {
				void handleCreateEnv();
			} else if (key.name === "escape") {
				setEditMode("none");
				setEditBuffer("");
			}
			return;
		}

		if (editMode === "search") {
			if (key.name === "return" || key.name === "escape") {
				setEditMode("none");
				if (key.name === "escape") setSearchQuery("");
			}
			return;
		}

		// Normal mode
		if (key.name === "tab") {
			setPanel((p) => (p === "envs" ? "vars" : "envs"));
			return;
		}

		if (panel === "envs") {
			if (key.name === "up") {
				setSelectedEnvIdx((p) => Math.max(0, p - 1));
				setSelectedVarIdx(0);
			}
			if (key.name === "down") {
				setSelectedEnvIdx((p) =>
					Math.min(environments.length - 1, p + 1),
				);
				setSelectedVarIdx(0);
			}
			if (key.raw === "n" || key.raw === "N") {
				setEditMode("new-env");
				setEditBuffer("");
			}
			if (key.raw === "b" || key.raw === "B") {
				if (!blueprint && environments.length > 0) {
					void handleCreateBlueprint();
				}
			}
		}

		if (panel === "vars" && selectedEnv) {
			if (key.name === "up") {
				setSelectedVarIdx((p) => Math.max(0, p - 1));
			}
			if (key.name === "down") {
				setSelectedVarIdx((p) =>
					Math.min(displayVars.length - 1, p + 1),
				);
			}
			if (key.raw === "/" || key.raw === "f" || key.raw === "F") {
				setEditMode("search");
				setSearchQuery("");
				return;
			}
			if (key.name === "return" || key.raw === "e" || key.raw === "E") {
				const v = displayVars[selectedVarIdx];
				if (v && v.status !== "missing") {
					setEditMode("edit-value");
					setEditBuffer(v.value ?? "");
				}
			}
			if (key.raw === "a" || key.raw === "A") {
				setEditMode("add-key");
				setNewKeyBuffer("");
				setEditBuffer("");
			}
			if (key.raw === "d" || key.raw === "D") {
				const v = displayVars[selectedVarIdx];
				if (v && v.status !== "missing") {
					setEditMode("confirm-delete");
				}
			}
			if (key.raw === "s" || key.raw === "S") {
				setSecretsHidden((p) => !p);
			}
		}
	});

	// ------------------------------------------------------------------
	// Render helpers
	// ------------------------------------------------------------------
	function maskValue(value: string, isBlueprintVar?: boolean): string {
		// Blueprint vars with empty/placeholder values show ************
		if (isBlueprintVar && (value === "" || value === "your_value_here")) {
			return "************";
		}
		if (!secretsHidden) return value;
		if (value.length === 0) return "(empty)";
		return "\u25CF".repeat(Math.min(value.length, 12));
	}

	function truncate(str: string, max: number): string {
		return str.length > max ? str.slice(0, max - 1) + "\u2026" : str;
	}

	function statusTag(status: "ok" | "extra" | "missing"): string {
		switch (status) {
			case "ok":
				return "";
			case "extra":
				return "extra";
			case "missing":
				return "missing";
		}
	}

	function statusColor(status: "ok" | "extra" | "missing"): string {
		switch (status) {
			case "ok":
				return colors.fg;
			case "extra":
				return colors.warning;
			case "missing":
				return colors.error;
		}
	}

	// Visible var rows with scroll
	const maxVarRows = Math.max(1, termHeight - 12);
	const varScrollOffset = Math.max(
		0,
		Math.min(
			selectedVarIdx - Math.floor(maxVarRows / 2),
			displayVars.length - maxVarRows,
		),
	);
	const visibleVars = displayVars.slice(
		varScrollOffset,
		varScrollOffset + maxVarRows,
	);

	// ------------------------------------------------------------------
	// Render
	// ------------------------------------------------------------------
	if (error) {
		return (
			<box flexDirection="column" padding={1}>
				<text fg={colors.error}>{`Error: ${error}`}</text>
			</box>
		);
	}

	if (envFiles.length === 0) {
		return (
			<box flexDirection="column" padding={1} gap={1}>
				<text fg={colors.accent}>Env Manager</text>
				<text fg={colors.fgDim}>
					No .env files found. Create one to get started:
				</text>
				{editMode === "new-env" ? (
					<box flexDirection="column" gap={1}>
						<text fg={colors.fg}>{"Name your environment (.env.<name>):"}</text>
						<input
							placeholder="e.g. local, staging, prod"
							onInput={setEditBuffer}
							focused
							textColor={colors.fg}
							backgroundColor={colors.bgSurface}
						/>
						<text fg={colors.fgDim}>{"Enter to create | Esc to cancel"}</text>
					</box>
				) : (
					<text fg={colors.accent}>
						Press N to create a new environment
					</text>
				)}
			</box>
		);
	}

	return (
		<box flexDirection="row" flexGrow={1}>
			{/* Left panel: Environments */}
			<box
				flexDirection="column"
				width={26}
				border
				borderColor={panel === "envs" ? colors.borderFocus : colors.border}
				paddingX={1}
			>
				<text fg={colors.fgBright}>Environments</text>
				<text fg={colors.fgDim}>
					{"\u2500".repeat(22)}
				</text>

				{!blueprint && (
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"  no blueprint  "}</text>
						<text fg={colors.accent}>{"B to create"}</text>
					</box>
				)}

				{environments.map((env, i) => {
					const isSelected = i === selectedEnvIdx;
					const prefix = isSelected ? "> " : "  ";
					const count = env.vars.length;
					const isBp = env.name === "example";
					const missing = (!isBp && blueprint)
						? compareWithBlueprint(blueprint, env).missingFromEnv
								.length
						: 0;

					return (
						<box key={env.filename} flexDirection="row">
							<text
								fg={isSelected ? colors.accent : colors.fg}
								bg={
									isSelected && panel === "envs"
										? colors.bgHighlight
										: undefined
								}
							>
								{`${prefix}${env.name}`}
							</text>
							<text fg={colors.fgDim}>
								{` ${count}`}
							</text>
							{isBp && (
								<text fg={colors.accentAlt}>
									{" blueprint"}
								</text>
							)}
							{missing > 0 && (
								<text fg={colors.warning}>
									{` -${missing}`}
								</text>
							)}
						</box>
					);
				})}

				{/* New env action */}
				{editMode === "new-env" ? (
					<box flexDirection="column" paddingTop={1}>
						<text fg={colors.fgDim}>{".env.<name>:"}</text>
						<input
							placeholder="e.g. local"
							onInput={setEditBuffer}
							focused
							textColor={colors.fg}
							backgroundColor={colors.bgSurface}
						/>
					</box>
				) : (
					<text fg={colors.fgDim}>{"  [N] New environment"}</text>
				)}

				{/* Gitignore warnings */}
				{gitignoreWarnings.length > 0 && (
					<>
						<text fg={colors.fgDim}>
							{"\u2500".repeat(22)}
						</text>
						<text fg={colors.warning}>
							{`${gitignoreWarnings.length} not gitignored`}
						</text>
					</>
				)}
			</box>

			{/* Right panel: Variables */}
			<box
				flexDirection="column"
				flexGrow={1}
				border
				borderColor={panel === "vars" ? colors.borderFocus : colors.border}
				paddingX={1}
			>
				{selectedEnv ? (
					<>
						<box flexDirection="row" gap={2}>
							<text fg={colors.fgBright}>
								{selectedEnv.filename}
							</text>
							<text fg={colors.fgDim}>
								{`${selectedEnv.vars.length} vars`}
							</text>
							{comparison && comparison.missingFromEnv.length > 0 && (
								<text fg={colors.warning}>
									{`${comparison.missingFromEnv.length} missing from blueprint`}
								</text>
							)}
							{comparison && comparison.notInBlueprint.length > 0 && (
								<text fg={colors.warning}>
									{`${comparison.notInBlueprint.length} not in blueprint`}
								</text>
							)}
						</box>

						{/* Search bar */}
						{editMode === "search" ? (
							<box flexDirection="row" gap={1}>
								<text fg={colors.accent}>{"/"}</text>
								<input
									placeholder="Search keys or values..."
									onInput={setSearchQuery}
									focused
									textColor={colors.fg}
									backgroundColor={colors.bgSurface}
								/>
								<text fg={colors.fgDim}>{"Enter to lock | Esc to clear"}</text>
							</box>
						) : searchQuery ? (
							<box flexDirection="row" gap={1}>
								<text fg={colors.accent}>{`/ ${searchQuery}`}</text>
								<text fg={colors.fgDim}>{`(${displayVars.length} matches)`}</text>
							</box>
						) : null}

						{/* Column headers */}
						<box flexDirection="row">
							<box width={2}>
								<text fg={colors.fgDim}>{" "}</text>
							</box>
							<box width={24}>
								<text fg={colors.fgDim}>KEY</text>
							</box>
							<box flexGrow={1}>
								<text fg={colors.fgDim}>VALUE</text>
							</box>
						</box>
						<text fg={colors.fgDim}>
							{"\u2500".repeat(60)}
						</text>

						{/* Selected variable detail bar */}
						{displayVars[selectedVarIdx] && displayVars[selectedVarIdx].key.length > 22 && (
							<box flexDirection="row" gap={1}>
								<text fg={colors.fgDim}>{"  "}</text>
								<text fg={colors.accent}>{displayVars[selectedVarIdx].key}</text>
							</box>
						)}

						{/* Variable rows */}
						{visibleVars.map((v) => {
							const actualIdx = displayVars.indexOf(v);
							const isSelected = actualIdx === selectedVarIdx;
							const prefix = isSelected ? ">" : " ";

							// Edit mode inline
							if (isSelected && editMode === "edit-value") {
								return (
									<box key={v.key} flexDirection="row">
										<box width={2}>
											<text fg={colors.accent}>{prefix}</text>
										</box>
										<box width={24}>
											<text fg={colors.fgBright}>
												{truncate(v.key, 22)}
											</text>
										</box>
										<box flexGrow={1}>
											<input
												placeholder="new value"
												onInput={setEditBuffer}
												focused
												textColor={colors.fg}
												backgroundColor={colors.bgHighlight}
											/>
										</box>
									</box>
								);
							}

							{/* Key color: normal=default, missing=red dim, extra=orange */}
							const keyColor = v.status === "missing"
								? colors.error
								: v.status === "extra"
									? colors.warning
									: isSelected
										? colors.fgBright
										: colors.fg;

							const tag = statusTag(v.status);

							return (
								<box key={v.key} flexDirection="row">
									<box width={2}>
										<text
											fg={
												isSelected
													? colors.accent
													: colors.fgDim
											}
										>
											{prefix}
										</text>
									</box>
									<box width={24}>
										<text
											fg={keyColor}
											bg={
												isSelected && panel === "vars"
													? colors.bgHighlight
													: undefined
											}
										>
											{truncate(v.key, 22)}
										</text>
									</box>
									<box flexGrow={1}>
										<text
											fg={
												v.status === "missing"
													? colors.fgDim
													: isBlueprint
														? colors.fgDim
														: colors.fg
											}
										>
											{v.value === null
												? "············"
												: truncate(
														maskValue(v.value, isBlueprint),
														30,
													)}
										</text>
									</box>
									{tag && (
										<text fg={statusColor(v.status)}>
											{` ${tag}`}
										</text>
									)}
								</box>
							);
						})}

						{displayVars.length === 0 && (
							<text fg={colors.fgDim}>
								No variables. Press A to add one.
							</text>
						)}

						{/* Add var inline */}
						{editMode === "add-key" && (
							<box flexDirection="column" paddingTop={1}>
								<text fg={colors.fgDim}>{"Variable name:"}</text>
								<input
									placeholder="e.g. API_KEY"
									onInput={setNewKeyBuffer}
									focused
									textColor={colors.fg}
									backgroundColor={colors.bgHighlight}
								/>
							</box>
						)}
						{editMode === "add-value" && (
							<box flexDirection="column" paddingTop={1}>
								<text fg={colors.fgDim}>{`Value for ${newKeyBuffer}:`}</text>
								<input
									placeholder="value"
									onInput={setEditBuffer}
									focused
									textColor={colors.fg}
									backgroundColor={colors.bgHighlight}
								/>
							</box>
						)}

						{/* Delete confirmation */}
						{editMode === "confirm-delete" && (
							<box paddingTop={1}>
								<text fg={colors.error}>
									{`Delete ${displayVars[selectedVarIdx]?.key}? Enter/y = yes, any other = cancel`}
								</text>
							</box>
						)}

						{/* Controls */}
						<box flexGrow={1} />
						<text fg={colors.fgDim}>
							{editMode === "search"
								? "Enter to lock results | Esc to clear search"
								: editMode !== "none"
									? "Enter confirm | Esc cancel"
									: "E edit | A add | D delete | S secrets | / search | Tab panel"}
						</text>
					</>
				) : (
					<text fg={colors.fgDim}>
						Select an environment from the left panel.
					</text>
				)}
			</box>
		</box>
	);
}
