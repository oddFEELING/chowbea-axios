/**
 * ScriptPalette — searchable script selector for empty process tabs.
 * Fills the content area with a centered palette. Pattern follows
 * the existing CommandPalette but adapted for package.json scripts.
 */

import { useState, useEffect, useMemo } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme/colors.js";

export interface ScriptEntry {
	name: string;
	command: string;
}

interface ScriptPaletteProps {
	scripts: ScriptEntry[];
	onRun: (entry: ScriptEntry) => void;
	onClose?: () => void; // close empty tab (when other tabs exist)
	onInputFocusChange: (focused: boolean) => void;
	canClose?: boolean; // whether Escape can close this tab
}

function truncate(str: string, maxLen: number): string {
	return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
}

export function ScriptPalette({
	scripts,
	onRun,
	onClose,
	onInputFocusChange,
	canClose,
}: ScriptPaletteProps) {
	const [filter, setFilter] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const { height: termHeight } = useTerminalDimensions();

	// Notify parent that we have an input focused
	useEffect(() => {
		onInputFocusChange(true);
		return () => onInputFocusChange(false);
	}, [onInputFocusChange]);

	const filtered = useMemo(() => {
		if (!filter) return scripts;
		const lower = filter.toLowerCase();
		return scripts.filter(
			(s) =>
				s.name.toLowerCase().includes(lower) ||
				s.command.toLowerCase().includes(lower),
		);
	}, [filter, scripts]);

	// Reset selection when filter changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [filter]);

	// Snap-scroll tracking
	const maxVisibleRows = Math.max(1, termHeight - 14); // leave room for chrome
	const scrollOffset = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(maxVisibleRows / 2),
			filtered.length - maxVisibleRows,
		),
	);
	const visibleScripts = filtered.slice(
		scrollOffset,
		scrollOffset + maxVisibleRows,
	);
	const hasMoreAbove = scrollOffset > 0;
	const hasMoreBelow = scrollOffset + maxVisibleRows < filtered.length;

	useKeyboard((key) => {
		if (key.name === "up") {
			setSelectedIndex((prev) =>
				prev > 0 ? prev - 1 : filtered.length - 1,
			);
			return;
		}

		if (key.name === "down") {
			setSelectedIndex((prev) =>
				prev < filtered.length - 1 ? prev + 1 : 0,
			);
			return;
		}

		if (key.name === "return") {
			const entry = filtered[selectedIndex];
			if (entry) onRun(entry);
			return;
		}

		if (key.name === "escape") {
			if (filter) {
				setFilter("");
			} else if (canClose && onClose) {
				onClose();
			}
			return;
		}
	});

	const handleInput = (value: string) => {
		setFilter(value);
	};

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			justifyContent="center"
			alignItems="center"
		>
			<box
				flexDirection="column"
				width={60}
				border
				borderColor={colors.accent}
				backgroundColor={colors.bgSurface}
				padding={1}
				title=" Scripts "
			>
				<input
					placeholder="> Filter scripts..."
					onInput={handleInput}
					focused
					textColor={colors.fg}
					backgroundColor={colors.bg}
				/>
				<text fg={colors.fgDim}>
					{"\u2500".repeat(56)}
				</text>

				{hasMoreAbove && (
					<text fg={colors.fgDim}>
						{`  \u25B2 ${scrollOffset} more`}
					</text>
				)}

				{visibleScripts.map((entry) => {
					const actualIndex = filtered.indexOf(entry);
					const isSelected = actualIndex === selectedIndex;
					const prefix = isSelected ? "\u2192 " : "  ";
					const cmdPreview = truncate(entry.command, 30);

					return (
						<box key={entry.name} flexDirection="row">
							<text
								fg={
									isSelected
										? colors.accent
										: colors.fgDim
								}
							>
								{prefix}
							</text>
							<text
								fg={
									isSelected
										? colors.fgBright
										: colors.fg
								}
								bg={
									isSelected
										? colors.bgHighlight
										: undefined
								}
							>
								{entry.name}
							</text>
							<text fg={colors.fgDim}>
								{"  " + cmdPreview}
							</text>
						</box>
					);
				})}

				{hasMoreBelow && (
					<text fg={colors.fgDim}>
						{`  \u25BC ${filtered.length - scrollOffset - maxVisibleRows} more`}
					</text>
				)}

				{filtered.length === 0 && (
					<text fg={colors.fgDim}>
						{"  No matching scripts"}
					</text>
				)}
			</box>

			<box paddingTop={1}>
				<text fg={colors.fgDim}>
					{canClose
						? "Up/Down select | Enter run | Esc close tab | Ctrl+T new tab"
						: "Up/Down select | Enter run | Ctrl+T new tab | Left/Right switch tab"}
				</text>
			</box>
		</box>
	);
}
