/**
 * Shared types for action functions.
 */

/** Result of client file generation (which files were created) */
export interface ClientFilesResult {
  helpers: boolean;
  instance: boolean;
  error: boolean;
  client: boolean;
}

/** Dry run result showing what would be generated */
export interface DryRunResult {
  operationCount: number;
  files: Array<{ path: string; action: string; lines: number }>;
}
