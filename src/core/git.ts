/**
 * Thin, synchronous wrappers around the `git` CLI.
 *
 * Shared by the `doctor` (untrack stray artifacts) and `resolve`
 * (regenerate-on-conflict) actions. Uses `spawnSync` without `shell: true`
 * (deprecated in Node 24, DEP0190). `git` is invoked by bare name: unlike the
 * package-manager shims, it ships as `git.exe` on Windows (resolved via PATH),
 * so it must NOT be rewritten to `git.cmd` the way `resolveCommand` does.
 */

import { spawnSync } from "node:child_process";

/** A git invocation that exited non-zero. */
export class GitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitError";
	}
}

function runGit(
	cwd: string,
	args: string[],
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function runGitOrThrow(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		throw new GitError(
			`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
		);
	}
	return result.stdout;
}

function parsePathLines(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** Whether `cwd` sits inside a git working tree. Never throws. */
export function isGitRepo(cwd: string): boolean {
	const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.status === 0 && result.stdout.trim() === "true";
}

/** Repo-relative paths of tracked files under `pathspec` (empty if none). */
export function listTrackedFiles(cwd: string, pathspec: string): string[] {
	return parsePathLines(runGitOrThrow(cwd, ["ls-files", "--", pathspec]));
}

/** Repo-relative paths of files currently in a merge-conflict (unmerged) state. */
export function listUnmergedFiles(cwd: string): string[] {
	return parsePathLines(
		runGitOrThrow(cwd, ["diff", "--name-only", "--diff-filter=U"]),
	);
}

/** Remove paths from the index but keep them on disk (`git rm -r --cached`). */
export function removeFromIndex(cwd: string, pathspecs: string[]): void {
	if (pathspecs.length === 0) return;
	runGitOrThrow(cwd, ["rm", "-r", "--cached", "--", ...pathspecs]);
}

/** Stage paths into the index (`git add`). */
export function stageFiles(cwd: string, pathspecs: string[]): void {
	if (pathspecs.length === 0) return;
	runGitOrThrow(cwd, ["add", "--", ...pathspecs]);
}
