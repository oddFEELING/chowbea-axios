/**
 * Shared utilities for Vite codegen plugins.
 *
 * Extracted here to avoid duplication between surfaces-codegen and
 * sidepanels-codegen.
 */

import path from "node:path";

/** Normalize a path to always use forward slashes (for import paths and Vite compatibility on Windows). */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/** Convert kebab-case to PascalCase: "create-staff" → "CreateStaff" */
export function toPascalCase(kebab: string): string {
  return kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Convert kebab-case to Title Case: "create-staff" → "Create Staff" */
export function toTitleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
