/**
 * Home screen — dashboard layout with ASCII art, config, spec cache,
 * endpoint breakdown with visual bar, and generated files grid.
 */

import { useState, useEffect } from "react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { colors } from "../theme/colors.js";
import {
	executeStatus,
	type StatusResult,
	type MethodCounts,
} from "../../core/actions/status.js";
import { createTuiLogger } from "../adapters/tui-logger.js";

function getVersion(): string {
	try {
		const thisDir = dirname(fileURLToPath(import.meta.url));
		const pkgPath = resolve(thisDir, "..", "..", "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
		return pkg.version;
	} catch {
		return "unknown";
	}
}

const LOGO = [
	"        __                    __                                  _           ",
	"  _____/ /_  ____ _      __ / /_  ___  ____ _      ____ __  __(_)___  _____",
	" / ___/ __ \\/ __ \\ | /| / // __ \\/ _ \\/ __ `/_____/ __ `/ |/_/ / __ \\/ ___/",
	"/ /__/ / / / /_/ / |/ |/ // /_/ /  __/ /_/ /_____/ /_/ />  </ / /_/ (__  ) ",
	"\\___/_/ /_/\\____/|__/|__//_.___/\\___/\\__,_/      \\__,_/_/|_/_/\\____/____/  ",
];

const TAGLINE = "openapi to axios \u2014 fetch, generate, ship";

/** Build a bar of filled + empty block characters. */
function bar(value: number, total: number, width: number): string {
	if (total === 0) return "\u2591".repeat(width);
	const filled = Math.round((value / total) * width);
	return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

/** Format a number with padding for alignment. */
function pad(n: number, w: number): string {
	return String(n).padStart(w);
}

/** Get the max count for padding alignment. */
function maxDigits(mc: MethodCounts): number {
	return String(Math.max(mc.get, mc.post, mc.put, mc.delete, mc.patch)).length;
}

export function HomeScreen() {
	const [result, setResult] = useState<StatusResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const version = getVersion();

	useEffect(() => {
		const { logger } = createTuiLogger("warn");
		executeStatus({}, logger)
			.then(setResult)
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
			})
			.finally(() => setLoading(false));
	}, []);

	if (loading) {
		return (
			<box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
				<text fg={colors.fgDim}>Loading dashboard...</text>
			</box>
		);
	}

	if (error) {
		return (
			<box flexDirection="column" flexGrow={1} gap={1}>
				<box flexDirection="column">
					{LOGO.map((line, i) => (
						<text key={i} fg={colors.accent}>{line}</text>
					))}
					<text>{""}</text>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{`  ${TAGLINE}  `}</text>
						<text fg={colors.accent}>{`v${version}`}</text>
					</box>
				</box>
				<text fg={colors.error}>{`  Error: ${error}`}</text>
			</box>
		);
	}

	if (!result) {
		return <text fg={colors.fgDim}>No data</text>;
	}

	const mc = result.methodCounts;
	const BAR_WIDTH = 20;
	const d = mc ? maxDigits(mc) : 1;
	const fileEntries = Object.entries(result.fileStatus);
	const mid = Math.ceil(fileEntries.length / 2);
	const leftFiles = fileEntries.slice(0, mid);
	const rightFiles = fileEntries.slice(mid);
	const allOk = fileEntries.every(([, s]) => s.exists);
	const missingCount = fileEntries.filter(([, s]) => !s.exists).length;

	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			{/* ASCII logo */}
			<box flexDirection="column">
				{LOGO.map((line, i) => (
					<text key={i} fg={colors.accent}>{line}</text>
				))}
				<text>{""}</text>
				<box flexDirection="row">
					<text fg={colors.fgDim}>{`  ${TAGLINE}  `}</text>
					<text fg={colors.accent}>{`v${version}`}</text>
				</box>
			</box>

			{/* Row 1: Config + Spec Cache side by side */}
			<box flexDirection="row" gap={1}>
				{/* Config card */}
				<box
					border
					borderColor={colors.border}
					paddingX={1}
					flexDirection="column"
					flexGrow={1}
				>
					<box flexDirection="row" gap={1}>
						<text fg={colors.accent}>{"\u25cf"}</text>
						<text fg={colors.fgBright}>Config</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"  endpoint  "}</text>
						<text fg={colors.info}>{result.endpoint}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"  output    "}</text>
						<text fg={colors.fg}>{result.outputFolder}</text>
					</box>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"  config    "}</text>
						<text fg={colors.fg}>{result.configPath}</text>
					</box>
				</box>

				{/* Spec Cache card */}
				<box
					border
					borderColor={colors.border}
					paddingX={1}
					flexDirection="column"
					flexGrow={1}
				>
					<box flexDirection="row" gap={1}>
						<text fg={result.specExists ? colors.success : colors.warning}>
							{"\u25cf"}
						</text>
						<text fg={colors.fgBright}>Spec Cache</text>
						<text fg={colors.fgDim}>
							{result.specExists ? "cached" : "empty"}
						</text>
					</box>
					{result.specExists && result.cacheMetadata ? (
						<>
							<box flexDirection="row">
								<text fg={colors.fgDim}>{"  hash      "}</text>
								<text fg={colors.accentAlt}>
									{result.cacheMetadata.hash.slice(0, 12)}
								</text>
							</box>
							<box flexDirection="row">
								<text fg={colors.fgDim}>{"  fetched   "}</text>
								<text fg={colors.fg}>
									{new Date(result.cacheMetadata.timestamp).toLocaleString()}
								</text>
							</box>
							<box flexDirection="row">
								<text fg={colors.fgDim}>{"  source    "}</text>
								<text fg={colors.fg}>
									{result.cacheMetadata.endpoint ?? "local"}
								</text>
							</box>
						</>
					) : (
						<>
							<text fg={colors.warning}>
								{"  No cached spec found"}
							</text>
							<text fg={colors.fgDim}>
								{"  Run Fetch (3) to download"}
							</text>
						</>
					)}
				</box>
			</box>

			{/* Row 2: Endpoints breakdown with visual bars */}
			{mc && mc.total > 0 && (
				<box
					border
					borderColor={colors.border}
					paddingX={1}
					flexDirection="column"
				>
					<box flexDirection="row" gap={1}>
						<text fg={colors.accent}>{"\u25cf"}</text>
						<text fg={colors.fgBright}>{`Endpoints`}</text>
						<text fg={colors.fgDim}>{`${mc.total} total`}</text>
					</box>
					{/* Method bars */}
					{mc.get > 0 && (
						<box flexDirection="row">
							<text fg={colors.methodGet}>{`  GET    ${pad(mc.get, d)}  `}</text>
							<text fg={colors.methodGet}>{bar(mc.get, mc.total, BAR_WIDTH)}</text>
							<text fg={colors.fgDim}>{`  ${Math.round((mc.get / mc.total) * 100)}%`}</text>
						</box>
					)}
					{mc.post > 0 && (
						<box flexDirection="row">
							<text fg={colors.methodPost}>{`  POST   ${pad(mc.post, d)}  `}</text>
							<text fg={colors.methodPost}>{bar(mc.post, mc.total, BAR_WIDTH)}</text>
							<text fg={colors.fgDim}>{`  ${Math.round((mc.post / mc.total) * 100)}%`}</text>
						</box>
					)}
					{mc.put > 0 && (
						<box flexDirection="row">
							<text fg={colors.methodPut}>{`  PUT    ${pad(mc.put, d)}  `}</text>
							<text fg={colors.methodPut}>{bar(mc.put, mc.total, BAR_WIDTH)}</text>
							<text fg={colors.fgDim}>{`  ${Math.round((mc.put / mc.total) * 100)}%`}</text>
						</box>
					)}
					{mc.delete > 0 && (
						<box flexDirection="row">
							<text fg={colors.methodDelete}>{`  DEL    ${pad(mc.delete, d)}  `}</text>
							<text fg={colors.methodDelete}>{bar(mc.delete, mc.total, BAR_WIDTH)}</text>
							<text fg={colors.fgDim}>{`  ${Math.round((mc.delete / mc.total) * 100)}%`}</text>
						</box>
					)}
					{mc.patch > 0 && (
						<box flexDirection="row">
							<text fg={colors.methodPatch}>{`  PATCH  ${pad(mc.patch, d)}  `}</text>
							<text fg={colors.methodPatch}>{bar(mc.patch, mc.total, BAR_WIDTH)}</text>
							<text fg={colors.fgDim}>{`  ${Math.round((mc.patch / mc.total) * 100)}%`}</text>
						</box>
					)}
				</box>
			)}

			{/* Row 3: Generated Files — 2 column grid */}
			<box
				border
				borderColor={colors.border}
				paddingX={1}
				flexDirection="column"
			>
				<box flexDirection="row" gap={1}>
					<text fg={allOk ? colors.success : colors.warning}>
						{"\u25cf"}
					</text>
					<text fg={colors.fgBright}>Generated Files</text>
					<text fg={colors.fgDim}>
						{allOk
							? `${fileEntries.length}/${fileEntries.length} ok`
							: `${missingCount} missing`}
					</text>
				</box>
				<box flexDirection="row">
					{/* Left column */}
					<box flexDirection="column" flexGrow={1}>
						{leftFiles.map(([name, status]) => (
							<box key={name} flexDirection="row">
								<text fg={status.exists ? colors.success : colors.error}>
									{status.exists ? "  \u2713 " : "  \u2717 "}
								</text>
								<text fg={colors.fg}>{`${name}  `}</text>
								<text fg={colors.fgDim}>
									{status.exists
										? status.modifiedAgo ?? ""
										: "missing"}
								</text>
							</box>
						))}
					</box>
					{/* Right column */}
					<box flexDirection="column" flexGrow={1}>
						{rightFiles.map(([name, status]) => (
							<box key={name} flexDirection="row">
								<text fg={status.exists ? colors.success : colors.error}>
									{status.exists ? "  \u2713 " : "  \u2717 "}
								</text>
								<text fg={colors.fg}>{`${name}  `}</text>
								<text fg={colors.fgDim}>
									{status.exists
										? status.modifiedAgo ?? ""
										: "missing"}
								</text>
							</box>
						))}
					</box>
				</box>
			</box>
		</box>
	);
}
