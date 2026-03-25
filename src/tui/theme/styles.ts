import { colors } from "./colors.js";

export const panelStyle = {
	border: true as const,
	borderColor: colors.border,
	backgroundColor: colors.bgSurface,
	padding: 1,
};

export const focusedPanelStyle = {
	...panelStyle,
	borderColor: colors.borderFocus,
};
