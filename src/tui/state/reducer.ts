import type { AppState, AppAction } from "./types.js";

export function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "NAVIGATE":
			return {
				...state,
				activeScreen: action.screen,
				sidebarFocused: false,
				commandPaletteOpen: false,
			};
		case "TOGGLE_SIDEBAR_FOCUS":
			return { ...state, sidebarFocused: !state.sidebarFocused };
		case "TOGGLE_COMMAND_PALETTE":
			return {
				...state,
				commandPaletteOpen: !state.commandPaletteOpen,
			};
		case "CLOSE_COMMAND_PALETTE":
			return { ...state, commandPaletteOpen: false };
		default:
			return state;
	}
}
