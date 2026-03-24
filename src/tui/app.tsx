import { useReducer, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { Shell } from "./components/shell.js";
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

export function App() {
	const [state, dispatch] = useReducer(appReducer, initialState);

	const navigate = useCallback((screen: ScreenId) => {
		dispatch({ type: "NAVIGATE", screen });
	}, []);

	useKeyboard((key) => {
		// Number keys for direct screen navigation
		const screenIndex = parseInt(key.name ?? "", 10);
		if (screenIndex >= 1 && screenIndex <= 7) {
			const screen = SCREENS[screenIndex - 1];
			if (screen) navigate(screen.id);
			return;
		}

		// Tab to toggle sidebar focus
		if (key.name === "tab") {
			dispatch({ type: "TOGGLE_SIDEBAR_FOCUS" });
			return;
		}

		// q to quit (not when ctrl is held)
		if (key.name === "q" && !key.ctrl) {
			process.exit(0);
		}
	});

	const renderScreen = () => {
		switch (state.activeScreen) {
			case "home":
				return <HomeScreen />;
			case "init":
				return <InitScreen />;
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
		}
	};

	return (
		<Shell
			activeScreen={state.activeScreen}
			sidebarFocused={state.sidebarFocused}
			onNavigate={navigate}
		>
			{renderScreen()}
		</Shell>
	);
}
