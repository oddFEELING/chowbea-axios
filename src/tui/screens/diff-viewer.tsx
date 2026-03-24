/**
 * Diff Viewer screen — compares current vs remote spec and shows added/removed/modified operations.
 * Calls executeDiff on mount and displays the structured results.
 */

import { useState, useEffect } from "react";
import { colors } from "../theme/colors.js";
import {
	executeDiff,
	type DiffResult,
	type OperationInfo,
} from "../../core/actions/diff.js";
import { createTuiLogger } from "../adapters/tui-logger.js";

export function DiffViewerScreen() {
	const [result, setResult] = useState<DiffResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const { logger } = createTuiLogger("warn");
		executeDiff({}, logger)
			.then(setResult)
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
			})
			.finally(() => setLoading(false));
	}, []);

	if (loading) {
		return <text fg={colors.fgDim}>Comparing specs...</text>;
	}

	if (error) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>
					Diff Viewer
				</text>
				<text fg={colors.error}>{`Error: ${error}`}</text>
			</box>
		);
	}

	if (!result) {
		return <text fg={colors.fgDim}>No diff data</text>;
	}

	if (result.identical) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>
					Diff Viewer
				</text>
				<text fg={colors.success}>
					Specs are identical - no changes detected.
				</text>
			</box>
		);
	}

	const totalChanges =
		result.added.length + result.removed.length + result.modified.length;

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Diff Viewer
			</text>

			{/* Summary counts */}
			<box flexDirection="row" gap={2}>
				<text
					fg={colors.success}
				>{`+${result.added.length} added`}</text>
				<text
					fg={colors.error}
				>{`-${result.removed.length} removed`}</text>
				<text
					fg={colors.warning}
				>{`~${result.modified.length} modified`}</text>
				<text fg={colors.fgDim}>{`(${totalChanges} total)`}</text>
			</box>

			{/* Added operations */}
			{result.added.length > 0 && (
				<box
					border
					borderColor={colors.success}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.success}>
						Added
					</text>
					{result.added.map((op) => (
						<OperationRow key={op.operationId} op={op} />
					))}
				</box>
			)}

			{/* Removed operations */}
			{result.removed.length > 0 && (
				<box
					border
					borderColor={colors.error}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.error}>
						Removed
					</text>
					{result.removed.map((op) => (
						<OperationRow key={op.operationId} op={op} />
					))}
				</box>
			)}

			{/* Modified operations */}
			{result.modified.length > 0 && (
				<box
					border
					borderColor={colors.warning}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.warning}>
						Modified
					</text>
					{result.modified.map((change) => (
						<box
							key={change.new.operationId}
							flexDirection="column"
						>
							<OperationRow op={change.new} />
							{change.old.method !== change.new.method && (
								<text fg={colors.fgDim}>
									{`  method: ${change.old.method} -> ${change.new.method}`}
								</text>
							)}
							{change.old.path !== change.new.path && (
								<text fg={colors.fgDim}>
									{`  path: ${change.old.path} -> ${change.new.path}`}
								</text>
							)}
							{change.old.hasRequestBody !==
								change.new.hasRequestBody && (
								<text fg={colors.fgDim}>
									{`  body: ${change.old.hasRequestBody ? "yes" : "no"} -> ${change.new.hasRequestBody ? "yes" : "no"}`}
								</text>
							)}
						</box>
					))}
				</box>
			)}
		</box>
	);
}

/** Renders a single operation line with colored HTTP method. */
function OperationRow({ op }: { op: OperationInfo }) {
	return (
		<text fg={colors.fg}>
			<text fg={methodColor(op.method)}>
				{op.method.toUpperCase().padEnd(7)}
			</text>
			{`${op.path}  `}
			<text fg={colors.fgDim}>{op.operationId}</text>
		</text>
	);
}

/** Map HTTP method to theme color. */
function methodColor(method: string): string {
	switch (method.toLowerCase()) {
		case "get":
			return colors.methodGet;
		case "post":
			return colors.methodPost;
		case "put":
			return colors.methodPut;
		case "delete":
			return colors.methodDelete;
		case "patch":
			return colors.methodPatch;
		default:
			return colors.fg;
	}
}
