import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A throwaway git repository in a temp directory, for exercising the
 * real `git` CLI in tests. Setup uses raw `spawnSync` (not the code under
 * test) so assertions don't depend on the module they're verifying.
 */
export interface TempGitRepo {
	/** Absolute path to the repo working tree. */
	dir: string;
	/** Run a git command that must succeed; returns stdout. Throws otherwise. */
	git: (args: string[]) => string;
	/** Run a git command that may fail (e.g. a conflicting merge). */
	tryGit: (args: string[]) => { status: number; stdout: string; stderr: string };
	/** Write a file (creating parent dirs) relative to the repo root. */
	write: (relPath: string, content: string) => void;
	/** Remove the temp directory. */
	cleanup: () => void;
}

/** Create a temp git repo with a deterministic `main` branch and an identity. */
export function makeTempGitRepo(): TempGitRepo {
	const dir = mkdtempSync(join(tmpdir(), "chowbea-git-test-"));

	const tryGit = (args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		return {
			status: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
		};
	};

	const git = (args: string[]): string => {
		const r = tryGit(args);
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
		}
		return r.stdout;
	};

	const write = (relPath: string, content: string): void => {
		const full = join(dir, relPath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	};

	git(["init", "-b", "main"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Chowbea Test"]);

	return {
		dir,
		git,
		tryGit,
		write,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
