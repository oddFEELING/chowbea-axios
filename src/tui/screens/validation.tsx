/**
 * Validation screen — runs spec validation and displays errors/warnings.
 * Calls executeValidate on mount and renders the structured results.
 */

import { useState, useEffect } from "react";
import { colors } from "../theme/colors.js";
import {
	executeValidate,
	type ValidateResult,
	type ValidationIssue,
} from "../../core/actions/validate.js";
import { createTuiLogger } from "../adapters/tui-logger.js";

export function ValidationScreen() {
	const [result, setResult] = useState<ValidateResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const { logger } = createTuiLogger("warn");
		executeValidate({}, logger)
			.then(setResult)
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
			})
			.finally(() => setLoading(false));
	}, []);

	if (loading) {
		return <text fg={colors.fgDim}>Validating spec...</text>;
	}

	if (error) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>
					Validation
				</text>
				<text fg={colors.error}>{`Error: ${error}`}</text>
			</box>
		);
	}

	if (!result) {
		return <text fg={colors.fgDim}>No validation data</text>;
	}

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>
				Validation
			</text>

			{/* Summary */}
			<box flexDirection="row" gap={2}>
				{result.valid ? (
					<text fg={colors.success}>
						Spec is valid
					</text>
				) : (
					<text fg={colors.error}>
						Spec has issues
					</text>
				)}
				<text fg={colors.fgDim}>
					{`${result.errors.length} error${result.errors.length !== 1 ? "s" : ""}, ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`}
				</text>
			</box>

			{/* Valid spec success message */}
			{result.valid && result.issues.length === 0 && (
				<box
					border
					borderColor={colors.success}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.success}>
						No issues found. Spec passes all checks.
					</text>
				</box>
			)}

			{/* Errors */}
			{result.errors.length > 0 && (
				<box
					border
					borderColor={colors.error}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.error}>
						{`Errors (${result.errors.length})`}
					</text>
					{result.errors.map((issue, i) => (
						<IssueRow key={i} issue={issue} />
					))}
				</box>
			)}

			{/* Warnings */}
			{result.warnings.length > 0 && (
				<box
					border
					borderColor={colors.warning}
					padding={1}
					flexDirection="column"
				>
					<text fg={colors.warning}>
						{`Warnings (${result.warnings.length})`}
					</text>
					{result.warnings.map((issue, i) => (
						<IssueRow key={i} issue={issue} />
					))}
				</box>
			)}
		</box>
	);
}

/** Renders a single validation issue with path and message. */
function IssueRow({ issue }: { issue: ValidationIssue }) {
	const color =
		issue.severity === "error" ? colors.error : colors.warning;

	return (
		<box flexDirection="row">
			<text fg={color}>
				{issue.severity === "error" ? "x " : "! "}
			</text>
			<text fg={colors.fgDim}>{issue.path}</text>
			<text fg={colors.fg}>{`  ${issue.message}`}</text>
		</box>
	);
}
