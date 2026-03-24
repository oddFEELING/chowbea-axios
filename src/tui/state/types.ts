export type ScreenId =
	| "home"
	| "init"
	| "fetch"
	| "diff"
	| "validate"
	| "watch"
	| "process"
	| "inspect";

export interface AppState {
	activeScreen: ScreenId;
	sidebarFocused: boolean;
	commandPaletteOpen: boolean;
	initialized: boolean | null; // null = checking, false = not initialized, true = ready
}

export type AppAction =
	| { type: "NAVIGATE"; screen: ScreenId }
	| { type: "TOGGLE_SIDEBAR_FOCUS" }
	| { type: "TOGGLE_COMMAND_PALETTE" }
	| { type: "CLOSE_COMMAND_PALETTE" }
	| { type: "SET_INITIALIZED"; value: boolean };

export const initialState: AppState = {
	activeScreen: "home",
	sidebarFocused: true,
	commandPaletteOpen: false,
	initialized: null, // checking on startup
};
