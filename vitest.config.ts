import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Snapshot files live next to the test that produced them.
		resolveSnapshotPath: (testPath, snapExtension) =>
			testPath.replace(/\.test\.ts$/, `.test${snapExtension}`),
		typecheck: {
			// Type-level tests live in `tests/types/*.test-d.ts`. Run with
			// `npm run test:types`, which invokes `vitest --typecheck.only`.
			tsconfig: "./tsconfig.tests.json",
			include: ["tests/types/**/*.test-d.ts"],
		},
	},
});
