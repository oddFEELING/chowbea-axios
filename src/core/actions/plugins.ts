/**
 * Plugins action — scan, inspect, and scaffold Vite codegen plugin files.
 *
 * Returns structured data for both the headless CLI and TUI plugins manager.
 */

import { readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { findProjectRoot } from "../config.js";
import {
  getSurfaceFiles,
  DEFINE_SURFACE_REGEX,
  buildSurfaceScaffold,
} from "../../vite/surfaces-codegen.js";
import {
  getPanelFiles,
  DEFINE_PANEL_REGEX,
  buildPanelScaffold,
} from "../../vite/sidepanels-codegen.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SurfaceInfo {
  id: string;
  constName: string;
  variant: "dialog" | "alert";
  closeOnAction: boolean;
  defaultProps: string[];
  filePath: string;
  group: string;
}

export interface PanelInfo {
  id: string;
  constName: string;
  contextParams: string[];
  routeParams: string[];
  filePath: string;
  group: string;
}

export interface PluginsResult {
  surfacesDir: string | null;
  sidepanelsDir: string | null;
  surfaces: SurfaceInfo[];
  panels: PanelInfo[];
  surfaceGroups: string[];
  panelGroups: string[];
  surfacesConfigured: boolean;
  sidepanelsConfigured: boolean;
}

export interface PluginsActionOptions {
  surfacesDir?: string;
  sidepanelsDir?: string;
}

// ---------------------------------------------------------------------------
// Metadata extraction regexes
// ---------------------------------------------------------------------------

/** Extract the full defineSurface(...) call arguments */
const SURFACE_META_REGEX =
  /defineSurface\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{([^}]*)\}(?:\s*,\s*\{([^}]*)\})?\s*\)/;

/** Extract field names from z.object({ key: z.xxx(), ... }) */
const CONTEXT_PARAMS_REGEX = /z\.object\(\s*\{([^}]+)\}/;

/** Extract routeParams array contents: routeParams: ['a', 'b'] */
const ROUTE_PARAMS_REGEX = /routeParams\s*:\s*\[([^\]]*)\]/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive group from relative file path: "user/edit-user.surface.tsx" → "user" */
function deriveGroup(filePath: string): string {
  return filePath.includes("/") ? filePath.split("/")[0] : "";
}

/** Extract unique sorted groups from a list of items, root ("") first. */
function extractGroups(items: Array<{ group: string }>): string[] {
  const set = new Set(items.map((i) => i.group));
  const groups = [...set].sort();
  // Ensure root is first if present
  if (groups.includes("")) {
    return ["", ...groups.filter((g) => g !== "")];
  }
  return groups;
}

/** Check if a directory exists. */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/** Parse surface metadata from file content. */
function parseSurfaceMetadata(
  content: string,
  filePath: string,
): SurfaceInfo | null {
  // First check if it even has a defineSurface export
  const nameMatch = content.match(DEFINE_SURFACE_REGEX);
  if (!nameMatch) return null;

  const constName = nameMatch[1];
  const group = deriveGroup(filePath);

  // Try to extract full metadata
  const metaMatch = content.match(SURFACE_META_REGEX);
  if (!metaMatch) {
    return {
      id: constName.toLowerCase().replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
      constName,
      variant: "dialog",
      closeOnAction: true,
      defaultProps: [],
      filePath,
      group,
    };
  }

  const id = metaMatch[1];
  const defaultsBlock = metaMatch[2] ?? "";
  const configBlock = metaMatch[3] ?? "";

  // Extract default prop keys
  const defaultProps = [...defaultsBlock.matchAll(/(\w+)\s*:/g)].map(
    (m) => m[1],
  );

  // Extract variant from config block
  const variantMatch = configBlock.match(/variant\s*:\s*['"](\w+)['"]/);
  const variant = (variantMatch?.[1] === "alert" ? "alert" : "dialog") as
    | "dialog"
    | "alert";

  // Extract closeOnAction from config block
  const closeMatch = configBlock.match(/closeOnAction\s*:\s*(true|false)/);
  const closeOnAction = closeMatch ? closeMatch[1] === "true" : true;

  return {
    id,
    constName,
    variant,
    closeOnAction,
    defaultProps,
    filePath,
    group,
  };
}

/** Parse panel metadata from file content. */
function parsePanelMetadata(
  content: string,
  filePath: string,
): PanelInfo | null {
  const nameMatch = content.match(DEFINE_PANEL_REGEX);
  if (!nameMatch) return null;

  const constName = nameMatch[1];
  const group = deriveGroup(filePath);

  // Extract id from definePanel('id', ...)
  const idMatch = content.match(/definePanel\s*\(\s*['"]([^'"]+)['"]/);
  const id = idMatch
    ? idMatch[1]
    : constName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

  // Extract contextParams field names
  const contextMatch = content.match(CONTEXT_PARAMS_REGEX);
  const contextParams = contextMatch
    ? [...contextMatch[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1])
    : [];

  // Extract routeParams
  const routeMatch = content.match(ROUTE_PARAMS_REGEX);
  const routeParams = routeMatch
    ? [...routeMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    : [];

  return {
    id,
    constName,
    contextParams,
    routeParams,
    filePath,
    group,
  };
}

// ---------------------------------------------------------------------------
// Core actions
// ---------------------------------------------------------------------------

/**
 * Scan the project for surfaces and panels, extracting metadata.
 */
export async function executePluginsScan(
  options: PluginsActionOptions,
  logger: Logger,
): Promise<PluginsResult> {
  const projectRoot = await findProjectRoot();

  const surfacesDir = options.surfacesDir ?? "src/components/surfaces";
  const sidepanelsDir = options.sidepanelsDir ?? "src/components/side-panels";

  const absSurfacesDir = path.join(projectRoot, surfacesDir);
  const absSidepanelsDir = path.join(projectRoot, sidepanelsDir);

  const surfacesConfigured = await dirExists(
    path.join(absSurfacesDir, "_registry"),
  );
  const sidepanelsConfigured = await dirExists(
    path.join(absSidepanelsDir, "_registry"),
  );

  // Scan surfaces
  const surfaces: SurfaceInfo[] = [];
  if (surfacesConfigured) {
    logger.debug(`Scanning surfaces in ${surfacesDir}`);
    for (const relPath of getSurfaceFiles(absSurfacesDir)) {
      const fullPath = path.join(absSurfacesDir, relPath);
      const content = readFileSync(fullPath, "utf-8");
      const info = parseSurfaceMetadata(content, relPath);
      if (info) surfaces.push(info);
    }
  }

  // Scan panels
  const panels: PanelInfo[] = [];
  if (sidepanelsConfigured) {
    logger.debug(`Scanning panels in ${sidepanelsDir}`);
    for (const relPath of getPanelFiles(absSidepanelsDir)) {
      const fullPath = path.join(absSidepanelsDir, relPath);
      const content = readFileSync(fullPath, "utf-8");
      const info = parsePanelMetadata(content, relPath);
      if (info) panels.push(info);
    }
  }

  return {
    surfacesDir: surfacesConfigured ? surfacesDir : null,
    sidepanelsDir: sidepanelsConfigured ? sidepanelsDir : null,
    surfaces,
    panels,
    surfaceGroups: extractGroups(surfaces),
    panelGroups: extractGroups(panels),
    surfacesConfigured,
    sidepanelsConfigured,
  };
}

/**
 * Scaffold a new surface file.
 */
export async function scaffoldNewSurface(
  name: string,
  surfacesDir: string,
  logger: Logger,
  group?: string,
): Promise<string> {
  const projectRoot = await findProjectRoot();
  const absSurfacesDir = path.join(projectRoot, surfacesDir);

  const targetDir = group
    ? path.join(absSurfacesDir, group)
    : absSurfacesDir;
  await mkdir(targetDir, { recursive: true });

  const fileName = `${name}.surface.tsx`;
  const filePath = path.join(targetDir, fileName);
  const relPath = group ? `${group}/${fileName}` : fileName;

  const content = buildSurfaceScaffold(name, relPath);
  await writeFile(filePath, content, "utf-8");

  logger.info(`Created ${relPath}`);
  return relPath;
}

/**
 * Scaffold a new panel file.
 */
export async function scaffoldNewPanel(
  name: string,
  sidepanelsDir: string,
  logger: Logger,
  group?: string,
): Promise<string> {
  const projectRoot = await findProjectRoot();
  const absSidepanelsDir = path.join(projectRoot, sidepanelsDir);

  const targetDir = group
    ? path.join(absSidepanelsDir, group)
    : absSidepanelsDir;
  await mkdir(targetDir, { recursive: true });

  const fileName = `${name}.panel.tsx`;
  const filePath = path.join(targetDir, fileName);
  const relPath = group ? `${group}/${fileName}` : fileName;

  const content = buildPanelScaffold(name, relPath);
  await writeFile(filePath, content, "utf-8");

  logger.info(`Created ${relPath}`);
  return relPath;
}
