export type ScreenId =
	| "home"
	| "init"
	| "fetch"
	| "diff"
	| "validate"
	| "process"
	| "inspect"
	| "env"
	| "plugins";

export interface AppState {
	activeScreen: ScreenId;
	sidebarFocused: boolean;
	commandPaletteOpen: boolean;
	initialized: boolean | null; // null = checking, false = not initialized, true = ready
	inputMode: boolean; // true when a screen has a text input focused
	quitDialogOpen: boolean;
}

export type AppAction =
	| { type: "NAVIGATE"; screen: ScreenId }
	| { type: "TOGGLE_SIDEBAR_FOCUS" }
	| { type: "TOGGLE_COMMAND_PALETTE" }
	| { type: "CLOSE_COMMAND_PALETTE" }
	| { type: "SET_INITIALIZED"; value: boolean }
	| { type: "SET_INPUT_MODE"; value: boolean }
	| { type: "OPEN_QUIT_DIALOG" }
	| { type: "CLOSE_QUIT_DIALOG" };

export const initialState: AppState = {
	activeScreen: "home",
	sidebarFocused: true,
	commandPaletteOpen: false,
	initialized: null, // checking on startup
	inputMode: false,
	quitDialogOpen: false,
};
