/**
 * Module-level process manager — lives outside React component lifecycle
 * so processes survive screen navigation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";

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
		const shell = isWindows ? "cmd" : "sh";
		const shellArgs = isWindows ? ["/c", entry.command] : ["-c", entry.command];

		const pathKey = isWindows ? "Path" : "PATH";
		const binDir = `${projectRoot}/node_modules/.bin`;
		const existingPath = process.env[pathKey] ?? "";
		const env = {
			...process.env,
			[pathKey]: `${binDir}${delimiter}${existingPath}`,
		};

		const child = spawn(shell, shellArgs, { cwd: projectRoot, env });
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

		const appendOutput = (chunk: Buffer, stream: "stdout" | "stderr") => {
			const lines = chunk.toString().split("\n").filter(Boolean);
			this.processes = this.processes.map((p) => {
				if (p.id !== id) return p;
				const merged = [
					...p.output,
					...lines.map((text) => ({ text, stream })),
				].slice(-MAX_OUTPUT_LINES);
				return { ...p, output: merged };
			});
			this.notify();
		};

		child.stdout?.on("data", (chunk: Buffer) => appendOutput(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => appendOutput(chunk, "stderr"));

		child.on("error", (err) => {
			this.children.delete(id);
			this.processes = this.processes.map((p) => {
				if (p.id !== id) return p;
				return {
					...p,
					output: [
						...p.output,
						{ text: `Failed to start: ${err.message}`, stream: "stderr" as const },
					].slice(-MAX_OUTPUT_LINES),
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
