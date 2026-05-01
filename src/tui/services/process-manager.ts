/**
 * Module-level process manager — lives outside React component lifecycle
 * so processes survive screen navigation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";

const MAX_OUTPUT_LINES = 500;

export interface OutputLine {
	text: string;
	stream: "stdout" | "stderr";
}

export interface ProcessInfo {
	id: string;
	name: string;
	command: string;
	output: OutputLine[];
	status: "running" | "stopped" | "crashed";
	exitCode: number | null;
}

type Listener = () => void;

/** Singleton process store — survives component unmount/remount. */
class ProcessManager {
	private children = new Map<string, ChildProcess>();
	private processes: ProcessInfo[] = [];
	private listeners = new Set<Listener>();

	/** Subscribe to state changes. Returns an unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify() {
		for (const fn of this.listeners) fn();
	}

	getProcesses(): ProcessInfo[] {
		return this.processes;
	}

	/** Spawn a new process for the given script. Returns the process id. */
	run(entry: { name: string; command: string }, projectRoot: string): string {
		const id = `${entry.name}-${Date.now()}`;
		const isWindows = process.platform === "win32";

		const pathKey = isWindows ? "Path" : "PATH";
		const binDir = join(projectRoot, "node_modules", ".bin");
		const existingPath = process.env[pathKey] ?? "";
		const env = {
			...process.env,
			[pathKey]: `${binDir}${delimiter}${existingPath}`,
		};

		// `shell: true` is intentional and unavoidable here: `entry.command` is
		// a user-supplied npm/pnpm/yarn/bun script string from the consumer's
		// own package.json (e.g. `npm run dev` or `cd foo && bun start`).
		// Running these requires shell-level parsing of `&&`, redirections,
		// env-var assignments, and PATHEXT resolution. This is the legitimate
		// use of shell:true; the deprecation in DEP0190 targets static-arg
		// invocations elsewhere in the codebase, which have been removed.
		// Issue #16.
		const child = spawn(entry.command, [], {
			cwd: projectRoot,
			env,
			shell: true,
		});
		this.children.set(id, child);

		const newProc: ProcessInfo = {
			id,
			name: entry.name,
			command: entry.command,
			output: [],
			status: "running",
			exitCode: null,
		};

		this.processes = [...this.processes, newProc];
		this.notify();

		// Append output lines in-place on the existing array, dropping the
		// oldest entries when we exceed `MAX_OUTPUT_LINES`. The previous
		// `[...output, ...lines].slice(-MAX)` rebuilt the entire array on
		// every chunk — O(n²) over time for long-running watch tasks. Now
		// we splice from the front only when the cap is exceeded, which is
		// O(k) per chunk (k = count of lines added), and use a fresh
		// process-info object for React reference identity. Issue #35.
		//
		// Also: `chunk.toString().split(/\r?\n/)` produces a trailing empty
		// element for the final newline. We strip ONLY that trailing
		// element rather than `.filter(Boolean)`-ing the whole array, so
		// intentional blank lines mid-output are preserved (a process
		// printing banner separators stays readable). Issue #35.
		const appendOutput = (chunk: Buffer, stream: "stdout" | "stderr") => {
			const parts = chunk.toString().split(/\r?\n/);
			if (parts.length > 0 && parts[parts.length - 1] === "") {
				parts.pop();
			}
			if (parts.length === 0) return;
			this.processes = this.processes.map((p) => {
				if (p.id !== id) return p;
				const next = p.output.slice();
				for (const text of parts) next.push({ text, stream });
				if (next.length > MAX_OUTPUT_LINES) {
					next.splice(0, next.length - MAX_OUTPUT_LINES);
				}
				return { ...p, output: next };
			});
			this.notify();
		};

		child.stdout?.on("data", (chunk: Buffer) => appendOutput(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => appendOutput(chunk, "stderr"));

		child.on("error", (err) => {
			this.children.delete(id);
			this.processes = this.processes.map((p) => {
				if (p.id !== id) return p;
				const next = p.output.slice();
				next.push({ text: `Failed to start: ${err.message}`, stream: "stderr" });
				if (next.length > MAX_OUTPUT_LINES) {
					next.splice(0, next.length - MAX_OUTPUT_LINES);
				}
				return {
					...p,
					output: next,
					status: "crashed",
					exitCode: null,
				};
			});
			this.notify();
		});

		child.on("close", (code, signal) => {
			this.children.delete(id);
			this.processes = this.processes.map((p) => {
				if (p.id !== id) return p;
				return {
					...p,
					status: code === 0 || signal != null ? "stopped" : "crashed",
					exitCode: code,
				};
			});
			this.notify();
		});

		return id;
	}

	/** Kill a process by id. */
	kill(id: string): void {
		const child = this.children.get(id);
		if (child) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already exited
			}
		}
	}

	/** Remove a stopped/crashed process from the list. */
	remove(id: string): void {
		this.processes = this.processes.filter((p) => p.id !== id);
		this.notify();
	}

	/** Kill all running processes (app shutdown only). */
	killAll(): void {
		for (const child of this.children.values()) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already exited
			}
		}
	}

	/** Count of currently running processes. */
	get runningCount(): number {
		return this.processes.filter((p) => p.status === "running").length;
	}
}

/** Singleton instance. */
export const processManager = new ProcessManager();
