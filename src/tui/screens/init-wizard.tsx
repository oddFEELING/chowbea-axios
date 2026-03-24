/**
 * Init screen -- context-aware: shows wizard for first-time setup,
 * settings editor for already-initialized projects.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { colors } from "../theme/colors.js";
import { createTuiLogger, type LogEntry } from "../adapters/tui-logger.js";
import {
	executeInit,
	type PromptProvider,
	type InitActionOptions,
	type InitResult,
} from "../../core/actions/init.js";
import {
	configExists,
	DEFAULT_CONFIG,
	DEFAULT_INSTANCE_CONFIG,
	findProjectRoot,
	generateConfigTemplate,
	getConfigPath,
	type ApiConfig,
} from "../../core/config.js";
import { detectPackageManager } from "../../core/pm.js";
import {
	loadCurrentConfig,
	regenerateClientFiles,
	saveConfig,
	syncScripts,
} from "../../core/actions/config-manager.js";

// ---------------------------------------------------------------------------
// Shared types and constants
// ---------------------------------------------------------------------------

interface WizardValues {
	endpoint: string;
	outputFolder: string;
	pm: "pnpm" | "yarn" | "bun" | "npm";
	authMode: "bearer-localstorage" | "custom" | "none";
	wantsConcurrent: boolean;
	concurrentName: string;
}

type Phase = "wizard" | "executing" | "done" | "error";

const PM_OPTIONS: Array<{ label: string; value: WizardValues["pm"] }> = [
	{ label: "pnpm", value: "pnpm" },
	{ label: "npm", value: "npm" },
	{ label: "yarn", value: "yarn" },
	{ label: "bun", value: "bun" },
];

const AUTH_OPTIONS: Array<{
	label: string;
	value: WizardValues["authMode"];
}> = [
	{
		label: "Bearer token from localStorage (SPA pattern)",
		value: "bearer-localstorage",
	},
	{ label: "Custom -- I'll implement my own auth logic", value: "custom" },
	{ label: "None -- no auth interceptor needed", value: "none" },
];

const CONCURRENT_OPTIONS: Array<{ label: string; value: boolean }> = [
	{ label: "Yes -- merge api:watch with my dev script", value: true },
	{ label: "No -- I'll run them separately", value: false },
];

const STEP_LABELS = [
	"API Endpoint",
	"Output Folder",
	"Package Manager",
	"Auth Mode",
	"Dev Script",
	"Preview",
	"Execute",
];

// ---------------------------------------------------------------------------
// Helper: build TOML preview from wizard values
// ---------------------------------------------------------------------------

function buildPreviewConfig(values: WizardValues): string {
	const config: ApiConfig = {
		api_endpoint: values.endpoint,
		poll_interval_ms: DEFAULT_CONFIG.poll_interval_ms,
		output: { folder: values.outputFolder },
		instance: {
			...DEFAULT_INSTANCE_CONFIG,
			auth_mode: values.authMode,
		},
		watch: { debug: false },
	};
	return generateConfigTemplate(config);
}

// ---------------------------------------------------------------------------
// Helper: build a PromptProvider that replays wizard values
// ---------------------------------------------------------------------------

function buildReplayProvider(values: WizardValues): PromptProvider {
	return {
		input: async (opts) => {
			if (opts.message.includes("endpoint")) return values.endpoint;
			if (
				opts.message.includes("placed") ||
				opts.message.includes("folder")
			)
				return values.outputFolder;
			// Concurrent script name
			if (opts.message.includes("concurrent"))
				return values.concurrentName;
			return opts.default ?? "";
		},
		select: async (opts) => {
			if (opts.choices.some((c) => c.value === "pnpm"))
				return values.pm as never;
			if (opts.choices.some((c) => c.value === "bearer-localstorage"))
				return values.authMode as never;
			return (opts.default ?? opts.choices[0].value) as never;
		},
		confirm: async (opts) => {
			// Concurrent setup -- user chose in wizard
			if (opts.message.includes("alongside"))
				return values.wantsConcurrent;
			// Destructive: overwrite existing config -- respect the default (no)
			if (opts.message.includes("Overwrite"))
				return opts.default ?? false;
			// Destructive: update existing scripts -- respect the default (no)
			if (opts.message.includes("Update") && opts.message.includes("script"))
				return opts.default ?? false;
			// "Continue with setup?" -- safe to proceed
			if (opts.message.includes("Continue"))
				return true;
			// Unknown confirms -- use whatever the safe default is
			return opts.default ?? false;
		},
		checkbox: async (opts) => {
			// Auto-select all available scripts for concurrent setup
			return opts.choices.map((c) => c.value) as never;
		},
	};
}

// ---------------------------------------------------------------------------
// Helper: log entry rendering
// ---------------------------------------------------------------------------

function logColor(level: LogEntry["level"]): string {
	switch (level) {
		case "error":
			return colors.error;
		case "warn":
			return colors.warning;
		case "done":
			return colors.success;
		case "step":
			return colors.accent;
		case "debug":
			return colors.fgDim;
		default:
			return colors.fg;
	}
}

function logPrefix(level: LogEntry["level"]): string {
	switch (level) {
		case "error":
			return "x";
		case "warn":
			return "!";
		case "done":
			return "v";
		case "step":
			return ">";
		case "debug":
			return ".";
		default:
			return "-";
	}
}

// ---------------------------------------------------------------------------
// WizardMode -- the original InitScreen wizard (moved here verbatim)
// ---------------------------------------------------------------------------

interface WizardModeProps {
	onComplete?: () => void;
}

function WizardMode({ onComplete }: WizardModeProps) {
	// Wizard state
	const [step, setStep] = useState(0);
	const [values, setValues] = useState<WizardValues>({
		endpoint: DEFAULT_CONFIG.api_endpoint,
		outputFolder: DEFAULT_CONFIG.output.folder,
		pm: "npm", // updated by auto-detection below
		authMode: "custom",
		wantsConcurrent: true,
		concurrentName: "dev:all",
	});
	const [selectedIndex, setSelectedIndex] = useState(0);

	// Execution state
	const [phase, setPhase] = useState<Phase>("wizard");
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [result, setResult] = useState<InitResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const runningRef = useRef(false);

	// Input value buffers for controlled inputs
	const [endpointDraft, setEndpointDraft] = useState(values.endpoint);
	const [outputDraft, setOutputDraft] = useState(values.outputFolder);

	// Auto-detect package manager from lockfile on mount
	useEffect(() => {
		findProjectRoot()
			.then((root) => detectPackageManager(root))
			.then((detected) => {
				setValues((prev) => ({ ...prev, pm: detected }));
			})
			.catch(() => {
				// Keep npm default if detection fails
			});
	}, []);

	// -----------------------------------------------------------------------
	// Execute init
	// -----------------------------------------------------------------------
	const runInit = useCallback(() => {
		if (runningRef.current) return;
		runningRef.current = true;
		setPhase("executing");
		setLogs([]);
		setResult(null);
		setError(null);

		const { logger, getLogs } = createTuiLogger("info");
		const prompts = buildReplayProvider(values);

		const options: InitActionOptions = {
			force: false,
			skipScripts: false,
			skipClient: false,
			skipConcurrent: !values.wantsConcurrent,
			baseUrlEnv: DEFAULT_INSTANCE_CONFIG.base_url_env,
			envAccessor: DEFAULT_INSTANCE_CONFIG.env_accessor,
			tokenKey: DEFAULT_INSTANCE_CONFIG.token_key,
			authMode: values.authMode,
			withCredentials: DEFAULT_INSTANCE_CONFIG.with_credentials,
			timeout: DEFAULT_INSTANCE_CONFIG.timeout,
		};

		const logInterval = setInterval(() => {
			setLogs(getLogs());
		}, 200);

		executeInit(options, logger, prompts)
			.then((res) => {
				clearInterval(logInterval);
				setLogs(getLogs());
				setResult(res);
				setPhase("done");
				onComplete?.();
			})
			.catch((e: unknown) => {
				clearInterval(logInterval);
				setLogs(getLogs());
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
				setPhase("error");
			})
			.finally(() => {
				runningRef.current = false;
			});
	}, [values, onComplete]);

	// -----------------------------------------------------------------------
	// Keyboard handling for select steps, navigation, and preview/execute
	// -----------------------------------------------------------------------
	useKeyboard((key) => {
		// Escape: go back one step (wizard only)
		if (key.name === "escape" && phase === "wizard" && step > 0) {
			const prevStep = step - 1;
			setStep(prevStep);
			// Reset selectedIndex for select steps
			if (prevStep === 2) {
				setSelectedIndex(
					PM_OPTIONS.findIndex((o) => o.value === values.pm),
				);
			} else if (prevStep === 3) {
				setSelectedIndex(
					AUTH_OPTIONS.findIndex((o) => o.value === values.authMode),
				);
			} else if (prevStep === 4) {
				setSelectedIndex(values.wantsConcurrent ? 0 : 1);
			}
			return;
		}

		// Select steps (2, 3, 4) keyboard
		if (phase === "wizard" && (step === 2 || step === 3 || step === 4)) {
			const options =
				step === 2
					? PM_OPTIONS
					: step === 3
						? AUTH_OPTIONS
						: CONCURRENT_OPTIONS;
			const maxIdx = options.length - 1;

			if (key.name === "up" || key.name === "k") {
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIdx));
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setSelectedIndex((prev) => (prev < maxIdx ? prev + 1 : 0));
				return;
			}
			if (key.name === "return") {
				if (step === 2) {
					const selected = PM_OPTIONS[selectedIndex];
					setValues((v) => ({
						...v,
						pm: selected.value as WizardValues["pm"],
					}));
					setSelectedIndex(
						AUTH_OPTIONS.findIndex(
							(o) => o.value === values.authMode,
						),
					);
				} else if (step === 3) {
					const selected = AUTH_OPTIONS[selectedIndex];
					setValues((v) => ({
						...v,
						authMode:
							selected.value as WizardValues["authMode"],
					}));
					setSelectedIndex(
						values.wantsConcurrent ? 0 : 1,
					);
				} else {
					const selected = CONCURRENT_OPTIONS[selectedIndex];
					setValues((v) => ({
						...v,
						wantsConcurrent: selected.value,
					}));
				}
				setStep(step + 1);
				return;
			}
		}

		// Preview step (5): Enter to confirm
		if (phase === "wizard" && step === 5 && key.name === "return") {
			setStep(6);
			return;
		}

		// Execute step (6): Enter to run
		if (
			phase === "wizard" &&
			step === 6 &&
			key.name === "return" &&
			!runningRef.current
		) {
			runInit();
			return;
		}
	});

	// -----------------------------------------------------------------------
	// Input submit handlers
	// -----------------------------------------------------------------------
	// NOTE: The onSubmit prop has an intersection type due to OpenTUI's
	// IntrinsicElements extending React's. OpenTUI calls it with (value: string)
	// but we must satisfy both signatures, so we accept `unknown` and narrow.
	const handleEndpointSubmit = useCallback(
		(valOrEvent: unknown) => {
			const val = typeof valOrEvent === "string" ? valOrEvent : "";
			const trimmed = val.trim() || DEFAULT_CONFIG.api_endpoint;
			setValues((v) => ({ ...v, endpoint: trimmed }));
			setEndpointDraft(trimmed);
			setStep(1);
		},
		[],
	);

	const handleOutputSubmit = useCallback(
		(valOrEvent: unknown) => {
			const val = typeof valOrEvent === "string" ? valOrEvent : "";
			const trimmed = val.trim() || DEFAULT_CONFIG.output.folder;
			setValues((v) => ({ ...v, outputFolder: trimmed }));
			setOutputDraft(trimmed);
			setSelectedIndex(
				PM_OPTIONS.findIndex((o) => o.value === values.pm),
			);
			setStep(2);
		},
		[values.pm],
	);

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	// Progress bar
	const progressItems = STEP_LABELS.map((label, i) => {
		let fg = colors.fgDim;
		if (i < step) fg = colors.success;
		if (i === step && phase === "wizard") fg = colors.accent;
		return { label, fg };
	});

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>Init Wizard</text>

			{/* Step progress */}
			<box flexDirection="row" gap={1}>
				{progressItems.map((item, i) => (
					<text key={i} fg={item.fg}>
						{i === step && phase === "wizard"
							? `[${i + 1}. ${item.label}]`
							: `${i + 1}. ${item.label}`}
					</text>
				))}
			</box>

			{/* Step 0: API Endpoint */}
			{phase === "wizard" && step === 0 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>
						Enter your OpenAPI spec endpoint URL:
					</text>
					<input
						placeholder={DEFAULT_CONFIG.api_endpoint}
						value={endpointDraft}
						onInput={setEndpointDraft}
						onSubmit={handleEndpointSubmit}
						focused={true}
					/>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to continue"}</text>
					</box>
				</box>
			)}

			{/* Step 1: Output Folder */}
			{phase === "wizard" && step === 1 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>
						Where should generated API files be placed?
					</text>
					<input
						placeholder={DEFAULT_CONFIG.output.folder}
						value={outputDraft}
						onInput={setOutputDraft}
						onSubmit={handleOutputSubmit}
						focused={true}
					/>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to continue, "}</text>
						<text fg={colors.accent}>{"Esc"}</text>
						<text fg={colors.fgDim}>{" to go back"}</text>
					</box>
				</box>
			)}

			{/* Step 2: Package Manager */}
			{phase === "wizard" && step === 2 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>
						Which package manager are you using?
					</text>
					{PM_OPTIONS.map((opt, i) => (
						<text
							key={opt.value}
							fg={
								i === selectedIndex
									? colors.accent
									: colors.fgDim
							}
						>
							{i === selectedIndex
								? `> ${opt.label}`
								: `  ${opt.label}`}
						</text>
					))}
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Use "}</text>
						<text fg={colors.accent}>{"up/down"}</text>
						<text fg={colors.fgDim}>{" to navigate, "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to select, "}</text>
						<text fg={colors.accent}>{"Esc"}</text>
						<text fg={colors.fgDim}>{" to go back"}</text>
					</box>
				</box>
			)}

			{/* Step 3: Auth Mode */}
			{phase === "wizard" && step === 3 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>
						How should auth tokens be attached to requests?
					</text>
					{AUTH_OPTIONS.map((opt, i) => (
						<text
							key={opt.value}
							fg={
								i === selectedIndex
									? colors.accent
									: colors.fgDim
							}
						>
							{i === selectedIndex
								? `> ${opt.label}`
								: `  ${opt.label}`}
						</text>
					))}
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Use "}</text>
						<text fg={colors.accent}>{"up/down"}</text>
						<text fg={colors.fgDim}>{" to navigate, "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to select, "}</text>
						<text fg={colors.accent}>{"Esc"}</text>
						<text fg={colors.fgDim}>{" to go back"}</text>
					</box>
				</box>
			)}

			{/* Step 4: Concurrent Dev Script */}
			{phase === "wizard" && step === 4 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>
						Merge api:watch with your dev script?
					</text>
					<text fg={colors.fgDim}>
						This creates a single command that runs both api:watch and your dev server together.
					</text>
					{CONCURRENT_OPTIONS.map((opt, i) => (
						<text
							key={String(opt.value)}
							fg={
								i === selectedIndex
									? colors.accent
									: colors.fgDim
							}
						>
							{i === selectedIndex
								? `> ${opt.label}`
								: `  ${opt.label}`}
						</text>
					))}
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Use "}</text>
						<text fg={colors.accent}>{"up/down"}</text>
						<text fg={colors.fgDim}>{" to navigate, "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to select, "}</text>
						<text fg={colors.accent}>{"Esc"}</text>
						<text fg={colors.fgDim}>{" to go back"}</text>
					</box>
				</box>
			)}

			{/* Step 5: Preview */}
			{phase === "wizard" && step === 5 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>
						Config Preview (api.config.toml)
					</text>
					<box
						border
						borderColor={colors.border}
						padding={1}
						flexDirection="column"
					>
						{buildPreviewConfig(values)
							.split("\n")
							.map((line, i) => (
								<text key={i} fg={colors.fg}>
									{line}
								</text>
							))}
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to confirm and proceed, "}</text>
						<text fg={colors.accent}>{"Esc"}</text>
						<text fg={colors.fgDim}>{" to go back"}</text>
					</box>
				</box>
			)}

			{/* Step 6: Execute (pre-run) */}
			{phase === "wizard" && step === 6 && (
				<box
					border
					borderColor={colors.borderFocus}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.fgBright}>Ready to initialize</text>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Endpoint:    "}</text>
						<text fg={colors.info}>{values.endpoint}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Output:      "}</text>
						<text fg={colors.info}>{values.outputFolder}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"PM:          "}</text>
						<text fg={colors.info}>{values.pm}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Auth:        "}</text>
						<text fg={colors.info}>{values.authMode}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Dev script:  "}</text>
						<text fg={colors.info}>{values.wantsConcurrent ? `yes (${values.concurrentName})` : "no"}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"Enter"}</text>
						<text fg={colors.fgDim}>{" to run init, "}</text>
						<text fg={colors.accent}>{"Esc"}</text>
						<text fg={colors.fgDim}>{" to go back"}</text>
					</box>
				</box>
			)}

			{/* Executing: live logs */}
			{phase === "executing" && (
				<box
					border
					borderColor={colors.info}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.info}>Initializing...</text>
					{logs.length > 0 && (
						<scrollbox focused={true} maxHeight={16}>
							{logs.map((entry, i) => (
								<text
									key={i}
									fg={logColor(entry.level)}
								>{`${logPrefix(entry.level)} ${entry.message}`}</text>
							))}
						</scrollbox>
					)}
				</box>
			)}

			{/* Done: result summary */}
			{phase === "done" && result && (
				<box
					border
					borderColor={colors.success}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.success}>Init Complete</text>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Config created:  "}</text>
						<text
							fg={
								result.configCreated
									? colors.success
									: colors.fgDim
							}
						>
							{result.configCreated ? "yes" : "no"}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Axios installed: "}</text>
						<text
							fg={
								result.axiosInstalled
									? colors.success
									: colors.fgDim
							}
						>
							{result.axiosInstalled ? "yes" : "already present"}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Scripts added:   "}</text>
						<text fg={colors.fg}>
							{result.scriptsAdded.length > 0
								? result.scriptsAdded.join(", ")
								: "none"}
						</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Client files:    "}</text>
						<text
							fg={
								result.clientFilesCreated.instance
									? colors.success
									: colors.fgDim
							}
						>
							{[
								result.clientFilesCreated.helpers &&
									"helpers",
								result.clientFilesCreated.instance &&
									"instance",
								result.clientFilesCreated.error && "error",
								result.clientFilesCreated.client &&
									"client",
							]
								.filter(Boolean)
								.join(", ") || "already exist"}
						</text>
					</box>

					{/* Show logs */}
					{logs.length > 0 && (
						<box
							border
							borderColor={colors.border}
							padding={1}
							flexDirection="column"
							maxHeight={12}
						>
							<text fg={colors.fgBright}>Log Output</text>
							<scrollbox focused={false}>
								{logs.map((entry, i) => (
									<text
										key={i}
										fg={logColor(entry.level)}
									>{`${logPrefix(entry.level)} ${entry.message}`}</text>
								))}
							</scrollbox>
						</box>
					)}
				</box>
			)}

			{/* Error */}
			{phase === "error" && error && (
				<box
					border
					borderColor={colors.error}
					padding={1}
					flexDirection="column"
					gap={1}
				>
					<text fg={colors.error}>Error</text>
					<text fg={colors.error}>{error}</text>

					{logs.length > 0 && (
						<box
							border
							borderColor={colors.border}
							padding={1}
							flexDirection="column"
							maxHeight={12}
						>
							<text fg={colors.fgBright}>Log Output</text>
							<scrollbox focused={false}>
								{logs.map((entry, i) => (
									<text
										key={i}
										fg={logColor(entry.level)}
									>{`${logPrefix(entry.level)} ${entry.message}`}</text>
								))}
							</scrollbox>
						</box>
					)}
				</box>
			)}
		</box>
	);
}

// ---------------------------------------------------------------------------
// SettingsMode -- config editor for already-initialized projects
// ---------------------------------------------------------------------------

interface FieldDef {
	key: string;
	label: string;
	section: string;
	type: "string" | "number" | "boolean" | "enum";
	options?: string[];
	min?: number;
}

const FIELDS: FieldDef[] = [
	{ key: "api_endpoint", label: "endpoint", section: "API", type: "string" },
	{ key: "spec_file", label: "spec_file", section: "API", type: "string" },
	{ key: "poll_interval_ms", label: "poll_interval", section: "API", type: "number", min: 1000 },
	{ key: "output.folder", label: "folder", section: "Output", type: "string" },
	{ key: "instance.auth_mode", label: "mode", section: "Auth", type: "enum", options: ["bearer-localstorage", "custom", "none"] },
	{ key: "instance.token_key", label: "token_key", section: "Auth", type: "string" },
	{ key: "instance.base_url_env", label: "base_url_env", section: "Auth", type: "string" },
	{ key: "instance.env_accessor", label: "env_accessor", section: "Auth", type: "enum", options: ["process.env", "import.meta.env"] },
	{ key: "instance.with_credentials", label: "credentials", section: "Auth", type: "boolean" },
	{ key: "instance.timeout", label: "timeout", section: "Auth", type: "number" },
	{ key: "watch.debug", label: "debug", section: "Watch", type: "boolean" },
];

const ACTION_LABELS = [
	"[R] Regenerate client files",
	"[S] Update package.json scripts",
	"[C] Setup concurrent dev script",
];

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
	return dotPath.split(".").reduce<unknown>(
		(o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
		obj,
	);
}

function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): Record<string, unknown> {
	const clone: Record<string, unknown> = JSON.parse(JSON.stringify(obj));
	const keys = dotPath.split(".");
	let current: Record<string, unknown> = clone;
	for (let i = 0; i < keys.length - 1; i++) {
		current = current[keys[i]] as Record<string, unknown>;
	}
	current[keys[keys.length - 1]] = value;
	return clone;
}

function SettingsMode() {
	const [config, setConfig] = useState<ApiConfig | null>(null);
	const [configPath, setConfigPath] = useState("");
	const [selectedRow, setSelectedRow] = useState(0);
	const [editingField, setEditingField] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState("");
	const [section, setSection] = useState<"config" | "actions">("config");
	const [actionIndex, setActionIndex] = useState(0);
	const [statusMsg, setStatusMsg] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Load config on mount
	useEffect(() => {
		loadCurrentConfig()
			.then(({ config: cfg, configPath: cfgPath }) => {
				setConfig(cfg);
				setConfigPath(cfgPath);
			})
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, []);

	// Clear status message after a delay
	useEffect(() => {
		if (statusMsg == null) return;
		const timer = setTimeout(() => setStatusMsg(null), 3000);
		return () => clearTimeout(timer);
	}, [statusMsg]);

	// Persist a config change to disk
	const persistConfig = useCallback(
		(updated: ApiConfig, changedKey: string) => {
			setConfig(updated);
			saveConfig(configPath, updated)
				.then(() => {
					if (changedKey === "api_endpoint") {
						setStatusMsg("Endpoint changed. Press R to regenerate client files.");
					} else if (changedKey === "instance.auth_mode") {
						setStatusMsg("Auth mode changed. Press R to regenerate client files.");
					} else {
						setStatusMsg("Saved");
					}
				})
				.catch((e: unknown) => {
					setStatusMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
				});
		},
		[configPath],
	);

	// Quick action handlers
	const handleRegenerate = useCallback(() => {
		setStatusMsg("Regenerating client files...");
		const { logger } = createTuiLogger("info");
		regenerateClientFiles(logger)
			.then((result) => {
				const created = [
					result.helpers && "helpers",
					result.instance && "instance",
					result.error && "error",
					result.client && "client",
				].filter(Boolean);
				setStatusMsg(
					created.length > 0
						? `Regenerated: ${created.join(", ")}`
						: "All client files already exist",
				);
			})
			.catch((e: unknown) => {
				setStatusMsg(`Regenerate failed: ${e instanceof Error ? e.message : String(e)}`);
			});
	}, []);

	const handleSyncScripts = useCallback(() => {
		setStatusMsg("Syncing scripts...");
		syncScripts()
			.then(({ added, updated }) => {
				if (added.length === 0 && updated.length === 0) {
					setStatusMsg("All scripts already up to date");
				} else {
					const parts: string[] = [];
					if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
					if (updated.length > 0) parts.push(`updated: ${updated.join(", ")}`);
					setStatusMsg(`Scripts ${parts.join("; ")}`);
				}
			})
			.catch((e: unknown) => {
				setStatusMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
			});
	}, []);

	// Keyboard handling
	useKeyboard((key) => {
		if (config == null) return;

		// Tab: toggle section
		if (key.name === "tab") {
			if (editingField != null) return; // don't switch while editing
			setSection((s) => (s === "config" ? "actions" : "config"));
			return;
		}

		// Escape: cancel editing
		if (key.name === "escape" && editingField != null) {
			setEditingField(null);
			setEditDraft("");
			return;
		}

		// Navigation
		if (key.name === "up" || key.name === "k") {
			if (editingField != null) return;
			if (section === "config") {
				setSelectedRow((prev) => (prev > 0 ? prev - 1 : FIELDS.length - 1));
			} else {
				setActionIndex((prev) => (prev > 0 ? prev - 1 : ACTION_LABELS.length - 1));
			}
			return;
		}
		if (key.name === "down" || key.name === "j") {
			if (editingField != null) return;
			if (section === "config") {
				setSelectedRow((prev) => (prev < FIELDS.length - 1 ? prev + 1 : 0));
			} else {
				setActionIndex((prev) => (prev < ACTION_LABELS.length - 1 ? prev + 1 : 0));
			}
			return;
		}

		// Enter: edit or toggle
		if (key.name === "return") {
			// Confirm edit
			if (editingField != null) {
				const field = FIELDS.find((f) => f.key === editingField);
				if (field) {
					let value: unknown = editDraft;
					if (field.type === "number") {
						const num = Number(editDraft);
						if (Number.isNaN(num) || (field.min != null && num < field.min)) {
							setStatusMsg(`Invalid number${field.min != null ? ` (min: ${field.min})` : ""}`);
							return;
						}
						value = num;
					}
					const updated = setNestedValue(
						config as unknown as Record<string, unknown>,
						field.key,
						value,
					) as unknown as ApiConfig;
					persistConfig(updated, field.key);
				}
				setEditingField(null);
				setEditDraft("");
				return;
			}

			// Actions section enter
			if (section === "actions") {
				if (actionIndex === 0) handleRegenerate();
				else if (actionIndex === 1) handleSyncScripts();
				else setStatusMsg("Concurrent dev script setup -- coming soon");
				return;
			}

			// Config section enter
			const field = FIELDS[selectedRow];
			if (field.type === "boolean") {
				const current = getNestedValue(config as unknown as Record<string, unknown>, field.key);
				const updated = setNestedValue(
					config as unknown as Record<string, unknown>,
					field.key,
					!current,
				) as unknown as ApiConfig;
				persistConfig(updated, field.key);
			} else if (field.type === "enum" && field.options) {
				const current = String(getNestedValue(config as unknown as Record<string, unknown>, field.key) ?? "");
				const idx = field.options.indexOf(current);
				const next = field.options[(idx + 1) % field.options.length];
				const updated = setNestedValue(
					config as unknown as Record<string, unknown>,
					field.key,
					next,
				) as unknown as ApiConfig;
				persistConfig(updated, field.key);
			} else {
				// string or number: enter edit mode
				const current = getNestedValue(config as unknown as Record<string, unknown>, field.key);
				setEditDraft(current != null ? String(current) : "");
				setEditingField(field.key);
			}
			return;
		}

		// Quick action shortcuts (only when in actions section and not editing)
		if (section === "actions" && editingField == null) {
			if (key.name === "r") { handleRegenerate(); return; }
			if (key.name === "s") { handleSyncScripts(); return; }
			if (key.name === "c") { setStatusMsg("Concurrent dev script setup -- coming soon"); return; }
		}
	});

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	if (loading) {
		return <text fg={colors.fgDim}>Loading settings...</text>;
	}

	if (error) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.error}>Failed to load config</text>
				<text fg={colors.error}>{error}</text>
			</box>
		);
	}

	if (config == null) {
		return <text fg={colors.fgDim}>No configuration found.</text>;
	}

	// Group fields by section for rendering
	let prevSection = "";
	const fieldRows = FIELDS.map((field, fieldIndex) => {
		const isSelected = selectedRow === fieldIndex && section === "config";
		const isEditing = editingField === field.key;
		const value = getNestedValue(config as unknown as Record<string, unknown>, field.key);
		const displayValue = value === undefined || value === "" ? "-" : String(value);

		const showHeader = field.section !== prevSection;
		prevSection = field.section;

		return (
			<box key={field.key} flexDirection="column">
				{showHeader && (
					<text fg={colors.accent}>{`  ${field.section}`}</text>
				)}
				<box flexDirection="row" height={1}>
					<text fg={isSelected ? colors.accent : colors.fgDim}>
						{isSelected ? "> " : "  "}
					</text>
					<text fg={colors.fgDim}>
						{`  ${field.label.padEnd(16)}`}
					</text>
					{isEditing ? (
						<input
							focused
							value={editDraft}
							onInput={setEditDraft}
							placeholder={displayValue}
						/>
					) : (
						<text fg={isSelected ? colors.fgBright : colors.fg}>
							{displayValue}
						</text>
					)}
				</box>
			</box>
		);
	});

	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			<text fg={colors.accent}>Settings</text>

			{/* Config fields */}
			<box border borderColor={section === "config" ? colors.borderFocus : colors.border} paddingX={1} flexDirection="column">
				{fieldRows}
			</box>

			{/* Quick Actions */}
			<box border borderColor={section === "actions" ? colors.borderFocus : colors.border} paddingX={1} flexDirection="column">
				<text fg={colors.fgBright}>Quick Actions</text>
				{ACTION_LABELS.map((label, i) => (
					<text
						key={label}
						fg={section === "actions" && actionIndex === i ? colors.accent : colors.fgDim}
					>
						{section === "actions" && actionIndex === i ? `> ${label}` : `  ${label}`}
					</text>
				))}
			</box>

			{/* Navigation hints */}
			<box flexDirection="row">
				<text fg={colors.fgDim}>{"Tab"}</text>
				<text fg={colors.fgDim}>{": switch section  "}</text>
				<text fg={colors.fgDim}>{"Up/Down"}</text>
				<text fg={colors.fgDim}>{": navigate  "}</text>
				<text fg={colors.fgDim}>{"Enter"}</text>
				<text fg={colors.fgDim}>{": edit/toggle"}</text>
			</box>

			{/* Status message */}
			{statusMsg != null && (
				<text fg={colors.success}>{statusMsg}</text>
			)}
		</box>
	);
}

// ---------------------------------------------------------------------------
// InitScreen -- router between WizardMode and SettingsMode
// ---------------------------------------------------------------------------

interface InitScreenProps {
	onComplete?: () => void;
}

export function InitScreen({ onComplete }: InitScreenProps) {
	const [initialized, setInitialized] = useState<boolean | null>(null);

	useEffect(() => {
		findProjectRoot()
			.then((root) => getConfigPath(root))
			.then((cfgPath) => configExists(cfgPath))
			.then((exists) => setInitialized(exists))
			.catch(() => setInitialized(false));
	}, []);

	if (initialized === null) {
		return <text fg={colors.fgDim}>Checking setup...</text>;
	}

	if (!initialized) {
		return (
			<WizardMode
				onComplete={() => {
					setInitialized(true);
					onComplete?.();
				}}
			/>
		);
	}

	return <SettingsMode />;
}
