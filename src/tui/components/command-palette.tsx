import { useState, useMemo } from "react";
import { useKeyboard } from "@opentui/react";
import { colors } from "../theme/colors.js";
import { SCREENS } from "./sidebar.js";
import type { ScreenId } from "../state/types.js";

interface CommandPaletteProps {
	onSelect: (screen: ScreenId) => void;
	onClose: () => void;
	onQuit: () => void;
}

interface PaletteItem {
	id: string;
	label: string;
	description: string;
	screen?: ScreenId;
	action?: () => void;
}

const SCREEN_DESCRIPTIONS: Record<ScreenId, string> = {
	home: "Status overview",
	init: "Project setup",
	fetch: "Fetch & generate",
	diff: "View API diffs",
	validate: "Schema validation",
	process: "Running processes",
	inspect: "Browse API endpoints",
	env: "Manage .env files",
	plugins: "Manage Surfaces & Panels",
};

function buildPaletteItems(onQuit: () => void): PaletteItem[] {
	return [
		...SCREENS.map((screen) => ({
			id: screen.id,
			label: screen.label,
			description: SCREEN_DESCRIPTIONS[screen.id],
			screen: screen.id,
		})),
		{
			id: "quit",
			label: "Quit",
			description: "Exit application",
			action: onQuit,
		},
	];
}

export function CommandPalette({ onSelect, onClose, onQuit }: CommandPaletteProps) {
	const [filter, setFilter] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);

	const paletteItems = useMemo(() => buildPaletteItems(onQuit), [onQuit]);

	const filteredItems = useMemo(() => {
		if (!filter) return paletteItems;
		const lower = filter.toLowerCase();
		return paletteItems.filter((item) =>
			item.label.toLowerCase().includes(lower),
		);
	}, [filter, paletteItems]);

	useKeyboard((key) => {
		if (key.name === "escape") {
			onClose();
			return;
		}

		if (key.name === "up") {
			if (filteredItems.length === 0) return;
			setSelectedIndex((prev) =>
				prev > 0 ? prev - 1 : filteredItems.length - 1,
			);
			return;
		}

		if (key.name === "down") {
			if (filteredItems.length === 0) return;
			setSelectedIndex((prev) =>
				prev < filteredItems.length - 1 ? prev + 1 : 0,
			);
			return;
		}

		if (key.name === "return") {
			if (filteredItems.length === 0) return;
			const item = filteredItems[selectedIndex];
			if (item) {
				if (item.action) {
					item.action();
				} else if (item.screen) {
					onSelect(item.screen);
				}
			}
			return;
		}
	});

	const handleInput = (value: string) => {
		setFilter(value);
		setSelectedIndex(0);
	};

	return (
		<box
			flexDirection="column"
			width={50}
			border
			borderColor={colors.accent}
			backgroundColor={colors.bgSurface}
			padding={1}
			title=" Command Palette "
		>
			<input
				placeholder="> Type to filter..."
				onInput={handleInput}
				focused
				textColor={colors.fg}
				backgroundColor={colors.bg}
			/>
			<text fg={colors.fgDim}>
				{"\u2500".repeat(46)}
			</text>
			{filteredItems.map((item, index) => {
				const isSelected = index === selectedIndex;
				const prefix = isSelected ? "\u2192 " : "  ";
				const number = paletteItems.indexOf(item) + 1;
				const label = `${prefix}${number}. ${item.label}`;
				const padding = " ".repeat(
					Math.max(1, 20 - label.length),
				);

				return (
					<text
						key={item.id}
						fg={isSelected ? colors.fgBright : colors.fg}
						bg={isSelected ? colors.bgHighlight : undefined}
					>
						{`${label}${padding}${item.description}`}
					</text>
				);
			})}
			{filteredItems.length === 0 && (
				<text fg={colors.fgDim}>{"  No matching items"}</text>
			)}
		</box>
	);
}
