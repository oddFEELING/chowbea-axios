/**
 * Validation screen — split-pane layout with category list on the left
 * and scrollable issue details on the right.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { colors } from "../theme/colors.js";
import {
	executeValidate,
	type ValidateResult,
	type CategorySummary,
} from "../../core/actions/validate.js";
import { createTuiLogger } from "../adapters/tui-logger.js";

type Phase = "loading" | "done" | "error";

export function ValidationScreen() {
	const [phase, setPhase] = useState<Phase>("loading");
	const [result, setResult] = useState<ValidateResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [focusIdx, setFocusIdx] = useState(0);
	const [pane, setPane] = useState<"left" | "right">("left");
	const runningRef = useRef(false);

	const runValidation = useCallback(() => {
		if (runningRef.current) return;
		runningRef.current = true;
		setPhase("loading");
		setResult(null);
		setError(null);

		const { logger } = createTuiLogger("warn");
		executeValidate({}, logger)
			.then((res) => {
				setResult(res);
				// Focus the first category with failures, or first category
				const firstFailed = res.categories.findIndex((c) => c.totalChecks > 0 && c.failed > 0);
				setFocusIdx(firstFailed >= 0 ? firstFailed : 0);
				setPhase("done");
			})
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
				setPhase("error");
			})
			.finally(() => {
				runningRef.current = false;
			});
	}, []);

	useEffect(() => {
		runValidation();
	}, [runValidation]);

	const visibleCategories = result?.categories.filter((c) => c.totalChecks > 0) ?? [];
	const selectedCategory = visibleCategories[focusIdx] ?? null;

	useKeyboard((key) => {
		if (phase === "loading") return;

		if (key.raw === "r") {
			runValidation();
			return;
		}

		if (phase !== "done" || visibleCategories.length === 0) return;

		// Tab switches between left (category list) and right (issue scroll) pane
		if (key.name === "tab") {
			setPane((prev) => (prev === "left" ? "right" : "left"));
			return;
		}

		// Left/right arrows also switch panes
		if (key.name === "right" && pane === "left") {
			setPane("right");
			return;
		}
		if (key.name === "left" && pane === "right") {
			setPane("left");
			return;
		}

		// Up/down navigates categories when left pane is focused
		if (pane === "left") {
			if (key.name === "up") {
				setFocusIdx((prev) => Math.max(0, prev - 1));
			} else if (key.name === "down") {
				setFocusIdx((prev) => Math.min(visibleCategories.length - 1, prev + 1));
			}
		}
		// When right pane is focused, scrollbox handles up/down natively
	});

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.accent}>Validation</text>

			{phase === "loading" && (
				<text fg={colors.fgDim}>Validating spec...</text>
			)}

			{phase === "error" && error && (
				<box border borderColor={colors.error} padding={1} flexDirection="column">
					<text fg={colors.error}>{`Error: ${error}`}</text>
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"Press "}</text>
						<text fg={colors.accent}>{"r"}</text>
						<text fg={colors.fgDim}>{" to retry."}</text>
					</box>
				</box>
			)}

			{phase === "done" && result && (
				<>
					{/* Summary line */}
					<box flexDirection="row" gap={2}>
						{result.valid ? (
							<text fg={colors.success}>Spec is valid</text>
						) : (
							<text fg={colors.error}>Spec has issues</text>
						)}
						<text fg={colors.fgDim}>
							{`${result.errors.length} error${result.errors.length !== 1 ? "s" : ""},  ${result.warnings.length} warning${result.warnings.length !== 1 ? "s" : ""}`}
						</text>
					</box>

					{/* Split pane */}
					<box flexDirection="row" gap={1} flexGrow={1}>
						{/* Left pane — category list */}
						<box
							border
							borderColor={pane === "left" ? colors.accent : colors.border}
							paddingX={1}
							paddingY={1}
							flexDirection="column"
							width={30}
						>
							{visibleCategories.map((cat, idx) => {
								const isFocused = idx === focusIdx;
								const icon = categoryIcon(cat);
								const iconColor = categoryColor(cat);
								const countStr = `${cat.passed}/${cat.totalChecks}`;

								return (
									<box key={cat.category} flexDirection="row">
										<text fg={isFocused ? colors.accent : colors.fgDim}>
											{isFocused ? "> " : "  "}
										</text>
										<text fg={iconColor}>{`${icon} `}</text>
										<text
											fg={isFocused ? colors.fgBright : colors.fg}
										>
											{cat.label}
										</text>
										<text fg={colors.fgDim}>
											{` ${countStr}`}
										</text>
									</box>
								);
							})}

							{/* Totals */}
							<text fg={colors.fgDim}>{""}</text>
							<TotalsRow categories={visibleCategories} />
						</box>

						{/* Right pane — issues for selected category */}
						<box
							border
							borderColor={pane === "right" ? colors.accent
								: selectedCategory && selectedCategory.failed > 0
									? categoryColor(selectedCategory)
									: colors.border}
							paddingX={1}
							paddingY={1}
							flexDirection="column"
							flexGrow={1}
						>
							{selectedCategory && (
								<>
									<box flexDirection="row" gap={1}>
										<text fg={categoryColor(selectedCategory)}>
											{`${categoryIcon(selectedCategory)} ${selectedCategory.label}`}
										</text>
										<text fg={colors.fgDim}>
											{selectedCategory.failed === 0
												? `All ${selectedCategory.totalChecks} checks passed`
												: `${selectedCategory.failed} issue${selectedCategory.failed !== 1 ? "s" : ""} found`}
										</text>
									</box>
									<text fg={colors.fgDim}>
										{"\u2500".repeat(40)}
									</text>

									{selectedCategory.failed === 0 ? (
										<text fg={colors.success}>
											No issues in this category.
										</text>
									) : (
										<scrollbox focused={pane === "right"}>
											{selectedCategory.issues.map((issue, i) => (
												<IssueRow key={i} issue={issue} />
											))}
										</scrollbox>
									)}
								</>
							)}
						</box>
					</box>

					{/* Controls */}
					<box flexDirection="row">
						<text fg={colors.fgDim}>{"  "}</text>
						<text fg={colors.accent}>{"up/down"}</text>
						<text fg={colors.fgDim}>{" navigate  "}</text>
						<text fg={colors.accent}>{"tab"}</text>
						<text fg={colors.fgDim}>{" switch pane  "}</text>
						<text fg={colors.accent}>{"r"}</text>
						<text fg={colors.fgDim}>{" re-run"}</text>
					</box>
				</>
			)}
		</box>
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categoryIcon(cat: CategorySummary): string {
	if (cat.failed === 0) return "v";
	if (cat.issues.some((i) => i.severity === "error")) return "x";
	if (cat.issues.some((i) => i.severity === "warning")) return "!";
	return "~";
}

function categoryColor(cat: CategorySummary): string {
	if (cat.failed === 0) return colors.success;
	if (cat.issues.some((i) => i.severity === "error")) return colors.error;
	if (cat.issues.some((i) => i.severity === "warning")) return colors.warning;
	return colors.info;
}

/**
 * Converts `/paths/api/users/{id}/get` to `GET /api/users/{id}`.
 * Falls back to raw path if it doesn't match.
 */
function formatPath(raw: string): string {
	const match = raw.match(/^\/paths(\/[^/].*)\/(get|post|put|patch|delete)$/);
	if (match) {
		return `${match[2].toUpperCase()} ${match[1]}`;
	}
	const parts = raw.split(", ");
	if (parts.length > 1) {
		return parts.map(formatPath).join("\n");
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function IssueRow({
	issue,
}: {
	issue: { severity: "error" | "warning" | "info"; path: string; message: string };
}) {
	let icon: string;
	let color: string;
	if (issue.severity === "error") {
		icon = "x";
		color = colors.error;
	} else if (issue.severity === "warning") {
		icon = "!";
		color = colors.warning;
	} else {
		icon = "~";
		color = colors.info;
	}

	return (
		<box flexDirection="column">
			<box flexDirection="row">
				<text fg={color}>{`  ${icon} `}</text>
				<text fg={colors.fgDim}>{formatPath(issue.path)}</text>
			</box>
			<text fg={colors.fg}>{`    ${issue.message}`}</text>
			<text>{""}</text>
		</box>
	);
}

function TotalsRow({ categories }: { categories: CategorySummary[] }) {
	const totalChecks = categories.reduce((s, c) => s + c.totalChecks, 0);
	const totalErrors = categories.reduce(
		(s, c) => s + c.issues.filter((i) => i.severity === "error").length,
		0,
	);
	const totalWarnings = categories.reduce(
		(s, c) => s + c.issues.filter((i) => i.severity === "warning").length,
		0,
	);
	const totalInfos = categories.reduce(
		(s, c) => s + c.issues.filter((i) => i.severity === "info").length,
		0,
	);

	return (
		<box flexDirection="column">
			<text fg={colors.fgDim}>{`${totalChecks} checks`}</text>
			<text fg={totalErrors > 0 ? colors.error : colors.fgDim}>
				{`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`}
			</text>
			<text fg={totalWarnings > 0 ? colors.warning : colors.fgDim}>
				{`${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""}`}
			</text>
			{totalInfos > 0 && (
				<text fg={colors.info}>
					{`${totalInfos} info${totalInfos !== 1 ? "s" : ""}`}
				</text>
			)}
		</box>
	);
}
