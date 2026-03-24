export type ScreenId =
	| "home"
	| "init"
	| "fetch"
	| "diff"
	| "validate"
	| "watch"
	| "process";

export interface AppState {
	activeScreen: ScreenId;
	sidebarFocused: boolean;
	commandPaletteOpen: boolean;
}

export type AppAction =
	| { type: "NAVIGATE"; screen: ScreenId }
	| { type: "TOGGLE_SIDEBAR_FOCUS" }
	| { type: "TOGGLE_COMMAND_PALETTE" }
	| { type: "CLOSE_COMMAND_PALETTE" };

export const initialState: AppState = {
	activeScreen: "home",
	sidebarFocused: true,
	commandPaletteOpen: false,
};
