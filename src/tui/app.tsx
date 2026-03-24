import { useReducer, useCallback, useEffect } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Shell } from "./components/shell.js";
import { CommandPalette } from "./components/command-palette.js";
import { appReducer } from "./state/reducer.js";
import { initialState, type ScreenId } from "./state/types.js";
import { SCREENS } from "./components/sidebar.js";
import { HomeScreen } from "./screens/home.js";
import { FetchGenerateScreen } from "./screens/fetch-generate.js";
import { DiffViewerScreen } from "./screens/diff-viewer.js";
import { ValidationScreen } from "./screens/validation.js";
import { WatchModeScreen } from "./screens/watch-mode.js";
import { InitScreen } from "./screens/init-wizard.js";
import { ProcessScreen } from "./screens/process-runner.js";
import { EndpointInspectorScreen } from "./screens/endpoint-inspector.js";
import { configExists, findProjectRoot, getConfigPath } from "../core/config.js";

export function App() {
	const [state, dispatch] = useReducer(appReducer, initialState);
	const renderer = useRenderer();

	// Check if project is initialized on mount
	useEffect(() => {
		findProjectRoot()
			.then((root) => getConfigPath(root))
			.then((configPath) => configExists(configPath))
			.then((exists) => {
				dispatch({ type: "SET_INITIALIZED", value: exists });
			})
			.catch(() => {
				dispatch({ type: "SET_INITIALIZED", value: false });
			});
	}, []);

	const navigate = useCallback((screen: ScreenId) => {
		dispatch({ type: "NAVIGATE", screen });
	}, []);

	// Callback for init screen to signal completion
	const handleInitComplete = useCallback(() => {
		dispatch({ type: "SET_INITIALIZED", value: true });
	}, []);

	useKeyboard((key) => {
		// Ctrl+P to toggle command palette — always global
		if (key.name === "p" && key.ctrl) {
			dispatch({ type: "TOGGLE_COMMAND_PALETTE" });
			return;
		}

		// Skip other shortcuts when command palette is open
		if (state.commandPaletteOpen) return;

		// Tab to toggle sidebar focus — always global
		if (key.name === "tab") {
			dispatch({ type: "TOGGLE_SIDEBAR_FOCUS" });
			return;
		}

		// Below here: only when sidebar is focused, so screens can
		// use number keys, 'q', etc. in their inputs without conflict.
		if (!state.sidebarFocused) return;

		// Number keys for direct screen navigation
		const screenIndex = parseInt(key.name ?? "", 10);
		if (screenIndex >= 1 && screenIndex <= SCREENS.length) {
			const screen = SCREENS[screenIndex - 1];
			if (screen) navigate(screen.id);
			return;
		}

		// q to quit
		if (key.name === "q" && !key.ctrl) {
			renderer.destroy();
		}
	});

	const renderScreen = () => {
		// Loading state
		if (state.initialized === null) {
			return <text fg="#565f89">Checking project setup...</text>;
		}

		// Not initialized — force init screen
		if (!state.initialized) {
			return <InitScreen onComplete={handleInitComplete} />;
		}

		switch (state.activeScreen) {
			case "home":
				return <HomeScreen />;
			case "init":
				return <InitScreen onComplete={handleInitComplete} />;
			case "fetch":
				return <FetchGenerateScreen />;
			case "diff":
				return <DiffViewerScreen />;
			case "validate":
				return <ValidationScreen />;
			case "watch":
				return <WatchModeScreen />;
			case "process":
				return <ProcessScreen />;
			case "inspect":
				return <EndpointInspectorScreen />;
		}
	};

	const handlePaletteSelect = useCallback(
		(screen: ScreenId) => {
			dispatch({ type: "NAVIGATE", screen });
			dispatch({ type: "CLOSE_COMMAND_PALETTE" });
		},
		[],
	);

	const handlePaletteClose = useCallback(() => {
		dispatch({ type: "CLOSE_COMMAND_PALETTE" });
	}, []);

	const handleQuit = useCallback(() => {
		renderer.destroy();
	}, [renderer]);

	return (
		<Shell
			activeScreen={state.initialized ? state.activeScreen : "init"}
			sidebarFocused={state.sidebarFocused}
			onNavigate={navigate}
			locked={!state.initialized}
		>
			{state.commandPaletteOpen ? (
				<CommandPalette
					onSelect={handlePaletteSelect}
					onClose={handlePaletteClose}
					onQuit={handleQuit}
				/>
			) : (
				renderScreen()
			)}
		</Shell>
	);
}
