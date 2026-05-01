import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Snapshot files live next to the test that produced them.
		resolveSnapshotPath: (testPath, snapExtension) =>
			testPath.replace(/\.test\.ts$/, `.test${snapExtension}`),
	},
});
