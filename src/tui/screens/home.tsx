/**
 * Home screen — displays project status: config, spec cache, endpoints, generated files.
 * Calls executeStatus on mount and renders the structured result.
 */

import { useState, useEffect } from "react";
import { colors } from "../theme/colors.js";
import {
	executeStatus,
	type StatusResult,
} from "../../core/actions/status.js";
import { createTuiLogger } from "../adapters/tui-logger.js";

export function HomeScreen() {
	const [result, setResult] = useState<StatusResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

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
		return <text fg={colors.fgDim}>Loading status...</text>;
	}

	if (error) {
		return <text fg={colors.error}>{`Error: ${error}`}</text>;
	}

	if (!result) {
		return <text fg={colors.fgDim}>No data</text>;
	}

	const mc = result.methodCounts;

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Home
			</text>

			{/* Config section */}
			<box border borderColor={colors.border} padding={1} flexDirection="column">
				<text fg={colors.fgBright}>
					Config
				</text>
				<text fg={colors.fgDim}>
					{`endpoint:  `}
					<text fg={colors.info}>{result.endpoint}</text>
				</text>
				<text fg={colors.fgDim}>
					{`output:    `}
					<text fg={colors.info}>{result.outputFolder}</text>
				</text>
				<text fg={colors.fgDim}>
					{`config:    `}
					<text fg={colors.fg}>{result.configPath}</text>
				</text>
			</box>

			{/* Spec Cache section */}
			<box border borderColor={colors.border} padding={1} flexDirection="column">
				<text fg={colors.fgBright}>
					Spec Cache
				</text>
				{result.specExists && result.cacheMetadata ? (
					<>
						<text fg={colors.fgDim}>
							{`hash:  `}
							<text fg={colors.fg}>
								{result.cacheMetadata.hash.slice(0, 8)}
							</text>
						</text>
						<text fg={colors.fgDim}>
							{`age:   `}
							<text fg={colors.fg}>
								{new Date(
									result.cacheMetadata.timestamp,
								).toLocaleString()}
							</text>
						</text>
					</>
				) : (
					<text fg={colors.warning}>
						No cached spec - run Fetch first
					</text>
				)}
			</box>

			{/* Endpoints section */}
			{mc && mc.total > 0 && (
				<box
					border
					borderColor={colors.border}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.fgBright}>{`Endpoints (${mc.total} total)`}</text>
					<box flexDirection="row" gap={2}>
						{mc.get > 0 && (
							<text fg={colors.methodGet}>{`GET: ${mc.get}`}</text>
						)}
						{mc.post > 0 && (
							<text
								fg={colors.methodPost}
							>{`POST: ${mc.post}`}</text>
						)}
						{mc.put > 0 && (
							<text fg={colors.methodPut}>{`PUT: ${mc.put}`}</text>
						)}
						{mc.delete > 0 && (
							<text
								fg={colors.methodDelete}
							>{`DEL: ${mc.delete}`}</text>
						)}
						{mc.patch > 0 && (
							<text
								fg={colors.methodPatch}
							>{`PATCH: ${mc.patch}`}</text>
						)}
					</box>
				</box>
			)}

			{/* Generated Files section */}
			<box border borderColor={colors.border} padding={1} flexDirection="column">
				<text fg={colors.fgBright}>
					Generated Files
				</text>
				{Object.entries(result.fileStatus).map(([name, status]) => (
					<text key={name} fg={colors.fgDim}>
						{`${name}: `}
						<text
							fg={status.exists ? colors.success : colors.error}
						>
							{status.exists
								? `ok ${status.modifiedAgo ?? ""}`
								: "missing"}
						</text>
					</text>
				))}
			</box>
		</box>
	);
}
