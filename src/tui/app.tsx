import { useReducer, useCallback, useEffect } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Shell } from "./components/shell.js";
import { CommandPalette } from "./components/command-palette.js";
import { QuitDialog } from "./components/quit-dialog.js";
import { appReducer } from "./state/reducer.js";
import { initialState, type ScreenId } from "./state/types.js";
import { SCREENS } from "./components/sidebar.js";
import { HomeScreen } from "./screens/home.js";
import { FetchGenerateScreen } from "./screens/fetch-generate.js";
import { DiffViewerScreen } from "./screens/diff-viewer.js";
import { ValidationScreen } from "./screens/validation.js";
import { InitScreen } from "./screens/init-wizard.js";
import { ProcessScreen } from "./screens/process-runner.js";
import { EndpointInspectorScreen } from "./screens/endpoint-inspector.js";
import { EnvManagerScreen } from "./screens/env-manager.js";
import { PluginsScreen } from "./screens/plugins-manager.js";
import { configExists, findProjectRoot, getConfigPath } from "../core/config.js";
import { processManager } from "./services/process-manager.js";

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

	const setInputMode = useCallback((value: boolean) => {
		dispatch({ type: "SET_INPUT_MODE", value });
	}, []);

	const doQuit = useCallback(() => {
		processManager.killAll();
		renderer.destroy();
	}, [renderer]);

	useKeyboard((key) => {
		// When quit dialog is open, let it handle everything
		if (state.quitDialogOpen) return;

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

		// Skip navigation shortcuts when a screen is in input mode
		if (state.inputMode) return;

		// Number keys for direct screen navigation — always global
		const screenIndex = parseInt(key.name ?? "", 10);
		if (screenIndex >= 1 && screenIndex <= SCREENS.length) {
			const screen = SCREENS[screenIndex - 1];
			if (screen) navigate(screen.id);
			return;
		}

		// q to open quit dialog — works from anywhere (except input mode)
		if (key.name === "q" && !key.ctrl) {
			dispatch({ type: "OPEN_QUIT_DIALOG" });
			return;
		}
	});

	const renderScreen = () => {
		// Loading state
		if (state.initialized === null) {
			return <text fg="#565f89">Checking project setup...</text>;
		}

		// Not initialized — force init screen
		if (!state.initialized) {
			return <InitScreen onComplete={handleInitComplete} setInputMode={setInputMode} />;
		}

		switch (state.activeScreen) {
			case "home":
				return <HomeScreen />;
			case "init":
				return <InitScreen onComplete={handleInitComplete} setInputMode={setInputMode} />;
			case "fetch":
				return <FetchGenerateScreen />;
			case "diff":
				return <DiffViewerScreen />;
			case "validate":
				return <ValidationScreen />;
			case "process":
				return <ProcessScreen setInputMode={setInputMode} />;
			case "inspect":
				return <EndpointInspectorScreen setInputMode={setInputMode} />;
			case "env":
				return <EnvManagerScreen setInputMode={setInputMode} />;
			case "plugins":
				return <PluginsScreen setInputMode={setInputMode} />;
			default: {
				const _exhaustive: never = state.activeScreen;
				return <text fg="#f7768e">Unknown screen: {_exhaustive}</text>;
			}
		}
	};

	const handlePaletteSelect = useCallback(
		(screen: ScreenId) => {
			dispatch({ type: "NAVIGATE", screen });
		},
		[],
	);

	const handlePaletteClose = useCallback(() => {
		dispatch({ type: "CLOSE_COMMAND_PALETTE" });
	}, []);

	const handleQuitCancel = useCallback(() => {
		dispatch({ type: "CLOSE_QUIT_DIALOG" });
	}, []);

	return (
		<Shell
			activeScreen={state.initialized ? state.activeScreen : "init"}
			locked={!state.initialized}
		>
			{state.quitDialogOpen ? (
				<QuitDialog onConfirm={doQuit} onCancel={handleQuitCancel} />
			) : state.commandPaletteOpen ? (
				<CommandPalette
					onSelect={handlePaletteSelect}
					onClose={handlePaletteClose}
					onQuit={doQuit}
				/>
			) : (
				renderScreen()
			)}
		</Shell>
	);
}
