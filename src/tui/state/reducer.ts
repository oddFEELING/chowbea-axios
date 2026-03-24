import type { AppState, AppAction } from "./types.js";

export function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "NAVIGATE":
			// Block navigation to other screens when not initialized
			if (!state.initialized && action.screen !== "init") {
				return state;
			}
			return {
				...state,
				activeScreen: action.screen,
				sidebarFocused: false,
				commandPaletteOpen: false,
			};
		case "TOGGLE_SIDEBAR_FOCUS":
			return { ...state, sidebarFocused: !state.sidebarFocused };
		case "TOGGLE_COMMAND_PALETTE":
			if (!state.initialized) return state;
			return {
				...state,
				commandPaletteOpen: !state.commandPaletteOpen,
			};
		case "CLOSE_COMMAND_PALETTE":
			return { ...state, commandPaletteOpen: false };
		case "SET_INITIALIZED":
			return {
				...state,
				initialized: action.value,
				// If just initialized, go to home; if not initialized, force init screen
				activeScreen: action.value ? "home" : "init",
			};
		default:
			return state;
	}
}
