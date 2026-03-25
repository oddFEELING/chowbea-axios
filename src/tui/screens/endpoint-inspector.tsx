/**
 * Endpoint Inspector screen -- browse and inspect API endpoints from the
 * parsed OpenAPI spec.  Three-panel layout: search bar, scrollable list,
 * and a detail pane with bordered cards for parameters, request body,
 * responses, and security schemes.
 */

import React, { useState, useEffect, useMemo } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme/colors.js";
import { createTuiLogger } from "../adapters/tui-logger.js";
import {
	executeInspect,
	type InspectResult,
	type EndpointDetail,
	type SchemaDetail,
} from "../../core/actions/inspect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FocusPanel = "search" | "list" | "detail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a theme color for a given HTTP method. */
function getMethodColor(method: string): string {
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

/** Return a theme color for an HTTP status code. */
function getStatusColor(statusCode: string): string {
	if (statusCode.startsWith("2")) return colors.success;
	if (statusCode.startsWith("3")) return colors.info;
	if (statusCode.startsWith("4")) return colors.warning;
	if (statusCode.startsWith("5")) return colors.error;
	return colors.fgDim;
}

/** Format a SchemaDetail into a compact type string (e.g. "string", "object", "integer[]"). */
function formatSchemaType(schema: SchemaDetail | undefined): string {
	if (!schema) return "any";
	if (schema.type === "array" && schema.items) {
		const inner = schema.items.refName ?? schema.items.type ?? "any";
		return `${inner}[]`;
	}
	if (schema.refName) return schema.refName;
	return schema.type ?? "any";
}

/** Render a path with {param} segments highlighted in accent color. */
function renderPath(path: string): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	const regex = /(\{[^}]+\})/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(path)) !== null) {
		// Static segment before the param
		if (match.index > lastIndex) {
			parts.push(
				<text key={`s-${lastIndex}`} fg={colors.fg}>
					{path.slice(lastIndex, match.index)}
				</text>,
			);
		}
		// The {param} itself
		parts.push(
			<text key={`p-${match.index}`} fg={colors.warning}>
				{match[1]}
			</text>,
		);
		lastIndex = regex.lastIndex;
	}

	// Trailing static segment
	if (lastIndex < path.length) {
		parts.push(
			<text key={`s-${lastIndex}`} fg={colors.fg}>
				{path.slice(lastIndex)}
			</text>,
		);
	}

	return parts;
}

// ---------------------------------------------------------------------------
// Schema rendering
// ---------------------------------------------------------------------------

/** A single row in the schema table (data only, no JSX). */
interface SchemaRow {
	field: string;
	type: string;
	required: boolean;
	isRef?: boolean;
	isTruncated?: boolean;
}

/** Recursively collect schema rows as flat data. */
function collectSchemaRows(
	schema: SchemaDetail,
	parentPath: string,
	maxDepth: number,
	rows: SchemaRow[],
): void {
	if (maxDepth <= 0 || schema.truncated) {
		rows.push({ field: "...", type: "", required: false, isTruncated: true });
		return;
	}

	if (schema.type === "object" && schema.properties) {
		if (schema.refName && !parentPath) {
			rows.push({
				field: `(${schema.refName})`,
				type: "",
				required: false,
				isRef: true,
			});
		}
		const requiredSet = new Set(schema.required ?? []);
		for (const [propName, propSchema] of Object.entries(
			schema.properties,
		)) {
			const fullName = parentPath
				? `${parentPath}.${propName}`
				: propName;
			const typeStr = formatSchemaType(propSchema);
			const fmt = propSchema.format ? ` (${propSchema.format})` : "";
			const nullable = propSchema.nullable ? "?" : "";

			rows.push({
				field: fullName,
				type: `${typeStr}${fmt}${nullable}`,
				required: requiredSet.has(propName),
			});

			if (propSchema.type === "object" && propSchema.properties) {
				collectSchemaRows(propSchema, fullName, maxDepth - 1, rows);
			} else if (
				propSchema.type === "array" &&
				propSchema.items?.type === "object" &&
				propSchema.items.properties
			) {
				collectSchemaRows(
					propSchema.items,
					`${fullName}[]`,
					maxDepth - 1,
					rows,
				);
			}
		}
	} else if (schema.type === "array" && schema.items) {
		rows.push({
			field: "(items)",
			type: formatSchemaType(schema.items),
			required: false,
		});
		if (
			schema.items.type === "object" &&
			schema.items.properties
		) {
			collectSchemaRows(schema.items, "", maxDepth - 1, rows);
		}
	}
}

/**
 * Render a schema as table rows with dynamically-sized columns.
 * Two-pass: collect data, compute widths, then render.
 */
function renderSchemaTable(
	schema: SchemaDetail,
	prefix: string,
	baseIndent = 2,
): React.ReactNode[] {
	const pad = " ".repeat(baseIndent);
	const dataRows: SchemaRow[] = [];
	collectSchemaRows(schema, "", 4, dataRows);

	if (dataRows.length === 0) return [];

	// Compute column widths from actual data
	const fieldW = Math.min(
		40,
		Math.max(8, ...dataRows.map((r) => r.field.length)) + 2,
	);
	const typeW = Math.min(
		25,
		Math.max(6, ...dataRows.map((r) => r.type.length)) + 2,
	);

	const elements: React.ReactNode[] = [];

	for (let i = 0; i < dataRows.length; i++) {
		const row = dataRows[i];
		if (!row) continue;

		if (row.isTruncated) {
			elements.push(
				<text key={`${prefix}-${i}-trunc`} fg={colors.fgDim}>
					{`${pad}...`}
				</text>,
			);
			continue;
		}

		if (row.isRef) {
			elements.push(
				<text key={`${prefix}-${i}-ref`} fg={colors.info}>
					{`${pad}${row.field}`}
				</text>,
			);
			continue;
		}

		elements.push(
			<box key={`${prefix}-${i}`} flexDirection="row">
				<text fg={colors.fg}>
					{`${pad}${row.field.padEnd(fieldW)}`}
				</text>
				<text fg={colors.accentAlt}>
					{row.type.padEnd(typeW)}
				</text>
				<text fg={row.required ? colors.warning : colors.fgDim}>
					{row.required ? "yes" : "-"}
				</text>
			</box>,
		);
	}

	return elements;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EndpointInspectorScreen({ setInputMode }: { setInputMode?: (v: boolean) => void }) {
	const [endpoints, setEndpoints] = useState<EndpointDetail[]>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [scrollOffset, setScrollOffset] = useState(0);
	const [focusPanel, setFocusPanel] = useState<FocusPanel>("list");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [specInfo, setSpecInfo] = useState<{
		title: string;
		version: string;
	} | null>(null);

	// Notify parent when search input is focused
	useEffect(() => {
		setInputMode?.(focusPanel === "search");
		return () => setInputMode?.(false);
	}, [focusPanel, setInputMode]);

	// Terminal height for dynamic visible rows
	const { height: termHeight } = useTerminalDimensions();
	// Subtract overhead: title(1) + search(3) + border(2) + status bar(1) + gaps
	// title(1) + search(3) + list border(2) + "▲ more"(1) + "▼ more"(1) + status bar(1) + hints(1) + gaps(3) + sidebar padding(2)
	const visibleRows = Math.max(10, termHeight - 15);

	// ------------------------------------------------------------------
	// Load endpoints on mount
	// ------------------------------------------------------------------
	useEffect(() => {
		const { logger } = createTuiLogger("warn");
		executeInspect({}, logger)
			.then((result: InspectResult) => {
				setEndpoints(result.endpoints);
				setSpecInfo({
					title: result.specTitle,
					version: result.specVersion,
				});
			})
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setError(msg);
			})
			.finally(() => setLoading(false));
	}, []);

	// ------------------------------------------------------------------
	// Filtered endpoints
	// ------------------------------------------------------------------
	const filtered = useMemo(() => {
		if (!searchQuery) return endpoints;

		// "#" prefix — summary + operationId + path
		if (searchQuery.startsWith("#")) {
			const q = searchQuery.slice(1).trim().toLowerCase();
			if (!q) return endpoints;
			return endpoints.filter(
				(ep) =>
					ep.summary?.toLowerCase().includes(q) ||
					ep.operationId?.toLowerCase().includes(q) ||
					ep.path.toLowerCase().includes(q),
			);
		}

		// ">" prefix — all fields
		if (searchQuery.startsWith(">")) {
			const q = searchQuery.slice(1).trim().toLowerCase();
			if (!q) return endpoints;
			return endpoints.filter((ep) => {
				const haystack = [
					ep.path,
					ep.method,
					ep.operationId,
					ep.summary,
					...(ep.tags ?? []),
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();
				return haystack.includes(q);
			});
		}

		// Default — summary + operationId
		const q = searchQuery.toLowerCase();
		return endpoints.filter(
			(ep) =>
				ep.summary?.toLowerCase().includes(q) ||
				ep.operationId?.toLowerCase().includes(q),
		);
	}, [endpoints, searchQuery]);

	// Reset selection when filter changes
	useEffect(() => {
		setSelectedIndex(0);
		setScrollOffset(0);
	}, [filtered]);

	const selectedEndpoint = filtered[selectedIndex] as
		| EndpointDetail
		| undefined;

	// ------------------------------------------------------------------
	// Keyboard
	// ------------------------------------------------------------------
	useKeyboard((key) => {
		// `/` focuses the search bar from anywhere
		if (key.raw === "/" && focusPanel !== "search") {
			setFocusPanel("search");
			return;
		}

		// Tab cycles panels
		if (key.name === "tab") {
			setFocusPanel((prev) => {
				if (prev === "search") return "list";
				if (prev === "list") return "detail";
				return "search";
			});
			return;
		}

		// Escape context-dependent
		if (key.name === "escape") {
			if (focusPanel === "search" && searchQuery) {
				setSearchQuery("");
				return;
			}
			if (focusPanel === "search") {
				setFocusPanel("list");
				return;
			}
			if (focusPanel === "detail") {
				setFocusPanel("list");
				return;
			}
			return;
		}

		// Enter context-dependent
		if (key.name === "return") {
			if (focusPanel === "search") {
				setFocusPanel("list");
				return;
			}
			if (focusPanel === "list") {
				setFocusPanel("detail");
				return;
			}
			return;
		}

		// Up / Down navigation in list panel (manual scroll)
		if (focusPanel === "list") {
			if (key.name === "up") {
				setSelectedIndex((prev) => {
					const next = Math.max(0, prev - 1);
					setScrollOffset((off) =>
						next < off ? next : off,
					);
					return next;
				});
			}
			if (key.name === "down") {
				setSelectedIndex((prev) => {
					const next = Math.min(
						filtered.length - 1,
						prev + 1,
					);
					setScrollOffset((off) =>
						next >= off + visibleRows
							? next - visibleRows + 1
							: off,
					);
					return next;
				});
			}
		}
	});

	// ------------------------------------------------------------------
	// Search handler
	// ------------------------------------------------------------------
	const handleSearch = (value: string) => {
		setSearchQuery(value);
	};

	// ------------------------------------------------------------------
	// Render helpers
	// ------------------------------------------------------------------

	function renderListItem(ep: EndpointDetail, isSelected: boolean) {
		const method = ep.method.toUpperCase();
		const label = ep.summary || ep.path;

		return (
			<box key={`${ep.method}-${ep.path}`} flexDirection="row" height={1}>
				<text fg={isSelected ? colors.accent : colors.fgDim}>
					{isSelected ? "\u25b6 " : "  "}
				</text>
				<text fg={getMethodColor(ep.method)}>
					{`${method.padEnd(7)} `}
				</text>
				<text
					fg={
						ep.deprecated
							? colors.fgDim
							: isSelected
								? colors.fgBright
								: colors.fg
					}
				>
					{label}
				</text>
			</box>
		);
	}

	function renderDetail(ep: EndpointDetail) {
		const paramGroups = groupParameters(ep.parameters ?? []);

		return (
			<box flexDirection="column" gap={1}>
				{/* Card 1: Header — hero style */}
				<box
					border
					borderColor={colors.accent}
					paddingX={2}
					paddingY={1}
					flexDirection="column"
					gap={1}
				>
					{/* Hero: method badge + summary */}
					<box flexDirection="row" gap={1}>
						<text
							fg="#1a1b26"
							bg={getMethodColor(ep.method)}
						>
							{` ${ep.method.toUpperCase()} `}
						</text>
						<text fg={colors.fgBright}>
							{ep.summary || ep.operationId || ep.path}
						</text>
						{ep.deprecated && (
							<text fg="#1a1b26" bg={colors.warning}>
								{" DEPRECATED "}
							</text>
						)}
					</box>

					{/* operationId — the function name developers care about */}
					{ep.operationId && (
						<box flexDirection="row" gap={1}>
							<text fg={colors.fgDim}>
								{"\u25c6"}
							</text>
							<text fg={colors.accent}>
								{ep.operationId}
							</text>
						</box>
					)}

					{/* Path with {params} highlighted */}
					<box flexDirection="row">
						{renderPath(ep.path)}
					</box>

					{/* Description */}
					{ep.description && (
						<text fg={colors.fg}>{ep.description}</text>
					)}

					{/* Tags */}
					<box flexDirection="column">
						{(ep.tags ?? []).length > 0 && (
							<box flexDirection="row" gap={1}>
								{ep.tags.map((tag) => (
									<text
										key={tag}
										fg={colors.accentAlt}
									>
										{`[${tag}]`}
									</text>
								))}
							</box>
						)}
					</box>
				</box>

			{/* Card 2: Parameters — dynamic table */}
				{paramGroups.length > 0 &&
					(() => {
						// Flatten all params for width calculation
						const allParams = paramGroups.flatMap((g) =>
							g.params.map((p) => ({
								...p,
								inLabel: g.label.toLowerCase(),
							})),
						);
						const nameW = Math.min(
							30,
							Math.max(
								6,
								...allParams.map((p) => p.name.length),
							) + 2,
						);
						const inW = Math.min(
							10,
							Math.max(
								4,
								...allParams.map((p) => p.inLabel.length),
							) + 2,
						);
						const typeW = Math.min(
							20,
							Math.max(
								6,
								...allParams.map((p) =>
									formatSchemaType(p.schema).length,
								),
							) + 2,
						);
						const divLen = nameW + inW + typeW + 8;

						return (
							<box
								border
								borderColor={colors.border}
								paddingX={1}
								flexDirection="column"
							>
								<text fg={colors.fgBright}>Parameters</text>
								<box flexDirection="row">
									<text fg={colors.fgDim}>
										{`  ${"Name".padEnd(nameW)}${"In".padEnd(inW)}${"Type".padEnd(typeW)}Required`}
									</text>
								</box>
								<text fg={colors.fgDim}>
									{`  ${"\u2500".repeat(divLen)}`}
								</text>
								{allParams.map((p) => (
									<box
										key={`${p.inLabel}-${p.name}`}
										flexDirection="row"
									>
										<text fg={colors.fg}>
											{`  ${p.name.padEnd(nameW)}`}
										</text>
										<text fg={colors.fgDim}>
											{p.inLabel.padEnd(inW)}
										</text>
										<text fg={colors.accentAlt}>
											{formatSchemaType(p.schema).padEnd(typeW)}
										</text>
										<text
											fg={
												p.required
													? colors.warning
													: colors.fgDim
											}
										>
											{p.required ? "yes" : "-"}
										</text>
									</box>
								))}
							</box>
						);
					})()}

				{/* Card 3: Request Body — table layout */}
				{ep.requestBody && (
					<box
						border
						borderColor={colors.border}
						paddingX={1}
						flexDirection="column"
					>
						<box flexDirection="row" gap={1}>
							<text fg={colors.fgBright}>
								Request Body
							</text>
							{ep.requestBody.required && (
								<text fg={colors.warning}>required</text>
							)}
						</box>
						{ep.requestBody.contentTypes.map((ct) => (
							<box
								key={ct.mediaType}
								flexDirection="column"
							>
								<text
									fg={colors.info}
								>{`  ${ct.mediaType}`}</text>
								{ct.schema &&
									renderSchemaTable(
										ct.schema,
										`req-${ct.mediaType}`,
									)}
							</box>
						))}
					</box>
				)}

				{/* Card 4: Responses — table layout */}
				{(ep.responses ?? []).length > 0 && (
					<box
						border
						borderColor={colors.border}
						paddingX={1}
						flexDirection="column"
					>
						<text fg={colors.fgBright}>Responses</text>
						{ep.responses.map((r) => (
							<box
								key={r.statusCode}
								flexDirection="column"
							>
								<box flexDirection="row" gap={1}>
									<text
										fg={getStatusColor(r.statusCode)}
									>{`  ${r.statusCode}`}</text>
									<text fg={colors.fg}>
										{r.description}
									</text>
								</box>
								{(r.contentTypes ?? []).map(
									(ct) =>
										ct.schema &&
										renderSchemaTable(
											ct.schema,
											`res-${r.statusCode}-${ct.mediaType}`,
											4,
										),
								)}
							</box>
						))}
					</box>
				)}

				{/* Card 5: Security */}
				{(ep.security ?? []).length > 0 && (
					<box
						border
						borderColor={colors.border}
						paddingX={1}
						flexDirection="column"
					>
						<text fg={colors.fgBright}>Security</text>
						{ep.security.map((scheme) => {
							const [name, scopes] =
								Object.entries(scheme)[0] ?? [
									"unknown",
									[],
								];
							return (
								<text
									key={name}
									fg={colors.fg}
								>{`  ${name}${(scopes as string[]).length ? `: ${(scopes as string[]).join(", ")}` : ""}`}</text>
							);
						})}
					</box>
				)}
			</box>
		);
	}

	// ------------------------------------------------------------------
	// Parameter grouping
	// ------------------------------------------------------------------

	interface ParamGroup {
		label: string;
		params: Array<{
			name: string;
			required: boolean;
			schema?: SchemaDetail;
		}>;
	}

	function groupParameters(
		params: EndpointDetail["parameters"],
	): ParamGroup[] {
		if (!params || params.length === 0) return [];

		const groups: Record<
			string,
			ParamGroup["params"]
		> = {};
		const order = ["path", "query", "header", "cookie"];

		for (const p of params) {
			const loc = p.in ?? "query";
			if (!groups[loc]) groups[loc] = [];
			groups[loc].push({
				name: p.name,
				required: p.required ?? false,
				schema: p.schema ?? undefined,
			});
		}

		const result: ParamGroup[] = [];
		for (const loc of order) {
			if (groups[loc] && groups[loc].length > 0) {
				result.push({
					label:
						loc.charAt(0).toUpperCase() + loc.slice(1),
					params: groups[loc],
				});
			}
		}
		return result;
	}

	// ------------------------------------------------------------------
	// Render: loading / error / empty states
	// ------------------------------------------------------------------

	if (loading) {
		return (
			<box
				flexDirection="column"
				flexGrow={1}
				justifyContent="center"
				alignItems="center"
			>
				<text fg={colors.fgDim}>
					Loading endpoints...
				</text>
			</box>
		);
	}

	if (error) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>Endpoint Inspector</text>
				<text fg={colors.error}>{`Error: ${error}`}</text>
			</box>
		);
	}

	if (endpoints.length === 0) {
		return (
			<box flexDirection="column" gap={1}>
				<text fg={colors.accent}>Endpoint Inspector</text>
				<text fg={colors.fgDim}>
					No endpoints found. Have you fetched a spec yet?
				</text>
			</box>
		);
	}

	// ------------------------------------------------------------------
	// Main layout
	// ------------------------------------------------------------------

	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			{/* Title row */}
			<box flexDirection="row" gap={2}>
				<text fg={colors.accent}>Endpoint Inspector</text>
				{specInfo && (
					<text fg={colors.fgDim}>
						{`${specInfo.title} v${specInfo.version}`}
					</text>
				)}
				<text
					fg={colors.fgDim}
				>{`${filtered.length}/${endpoints.length}`}</text>
			</box>

			{/* Search bar */}
			<box
				border
				borderColor={
					focusPanel === "search"
						? colors.borderFocus
						: colors.border
				}
				paddingX={1}
				height={3}
			>
				<input
					placeholder="/ Search summary + opId  # + paths  > all fields"
					onInput={handleSearch}
					focused={focusPanel === "search"}
					textColor={colors.fg}
					backgroundColor={colors.bg}
				/>
			</box>

			{/* Main: list + detail side by side */}
			<box flexDirection="row" flexGrow={1} gap={1}>
				{/* Left: endpoint list */}
				<box
					border
					borderColor={
						focusPanel === "list"
							? colors.borderFocus
							: colors.border
					}
					paddingX={1}
					flexDirection="column"
					width="35%"
					flexGrow={0}
					flexShrink={0}
				>
					{filtered.length > 0 ? (
						<box flexDirection="column" flexGrow={1}>
							{scrollOffset > 0 && (
								<text fg={colors.fgDim}>
									{`  \u25b2 ${scrollOffset} more`}
								</text>
							)}
							{filtered
								.slice(scrollOffset, scrollOffset + visibleRows)
								.map((ep, i) =>
									renderListItem(
										ep,
										i + scrollOffset === selectedIndex,
									),
								)}
							{scrollOffset + visibleRows < filtered.length && (
								<text fg={colors.fgDim}>
									{`  \u25bc ${filtered.length - scrollOffset - visibleRows} more`}
								</text>
							)}
						</box>
					) : (
						<text fg={colors.fgDim}>
							No matching endpoints
						</text>
					)}
				</box>

				{/* Right: detail */}
				<box
					border
					borderColor={
						focusPanel === "detail"
							? colors.borderFocus
							: colors.border
					}
					paddingX={1}
					flexDirection="column"
					flexGrow={1}
				>
					<scrollbox
						focused={focusPanel === "detail"}
						flexGrow={1}
					>
						{selectedEndpoint ? (
							renderDetail(selectedEndpoint)
						) : (
							<text fg={colors.fgDim}>
								Select an endpoint
							</text>
						)}
					</scrollbox>
				</box>
			</box>

			{/* Keyboard hint */}
			<text fg={colors.fgDim}>
				{
					"/ search | Tab switch panel | Up/Down navigate | Enter select | Esc back"
				}
			</text>
		</box>
	);
}
