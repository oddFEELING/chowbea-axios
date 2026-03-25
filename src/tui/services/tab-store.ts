/**
 * Module-level tab store — lives outside React component lifecycle
 * so tab state survives screen navigation.
 */

type Listener = () => void;

export interface Tab {
	id: string;
	processId: string | null; // null = empty tab (show palette)
	label: string;
}

interface TabSnapshot {
	tabs: Tab[];
	activeTabId: string;
}

class TabStore {
	private tabs: Tab[] = [{ id: "tab-initial", processId: null, label: "New" }];
	private activeTabId = "tab-initial";
	private listeners = new Set<Listener>();
	private cachedSnapshot: TabSnapshot | null = null;

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify() {
		this.cachedSnapshot = null;
		for (const fn of this.listeners) fn();
	}

	getSnapshot(): TabSnapshot {
		if (!this.cachedSnapshot) {
			this.cachedSnapshot = {
				tabs: this.tabs,
				activeTabId: this.activeTabId,
			};
		}
		return this.cachedSnapshot;
	}

	/** Create a new empty tab and make it active. */
	addTab(): void {
		const tab: Tab = {
			id: `tab-${Date.now()}`,
			processId: null,
			label: "New",
		};
		this.tabs = [...this.tabs, tab];
		this.activeTabId = tab.id;
		this.notify();
	}

	/** Close a tab. If it's the last one, auto-create a new empty tab. */
	closeTab(tabId: string): void {
		const idx = this.tabs.findIndex((t) => t.id === tabId);
		if (idx === -1) return;

		this.tabs = this.tabs.filter((t) => t.id !== tabId);

		if (this.tabs.length === 0) {
			const newTab: Tab = {
				id: `tab-${Date.now()}`,
				processId: null,
				label: "New",
			};
			this.tabs = [newTab];
			this.activeTabId = newTab.id;
		} else if (this.activeTabId === tabId) {
			// Move to nearest sibling (prefer left, fall back right)
			const newIdx = Math.min(idx, this.tabs.length - 1);
			this.activeTabId = this.tabs[newIdx]!.id;
		}

		this.notify();
	}

	/** Switch to a specific tab. */
	setActiveTab(tabId: string): void {
		if (this.tabs.some((t) => t.id === tabId)) {
			this.activeTabId = tabId;
			this.notify();
		}
	}

	/** Attach a process to a tab (palette → log viewer). */
	attachProcess(tabId: string, processId: string, label: string): void {
		this.tabs = this.tabs.map((t) =>
			t.id === tabId ? { ...t, processId, label } : t,
		);
		this.notify();
	}

	/** Cycle to next tab (wraps around). */
	nextTab(): void {
		const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
		const next = (idx + 1) % this.tabs.length;
		this.activeTabId = this.tabs[next]!.id;
		this.notify();
	}

	/** Cycle to previous tab (wraps around). */
	prevTab(): void {
		const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
		const prev = (idx - 1 + this.tabs.length) % this.tabs.length;
		this.activeTabId = this.tabs[prev]!.id;
		this.notify();
	}

	/** Get the currently active tab. */
	getActiveTab(): Tab | undefined {
		return this.tabs.find((t) => t.id === this.activeTabId);
	}
}

/** Singleton instance. */
export const tabStore = new TabStore();
