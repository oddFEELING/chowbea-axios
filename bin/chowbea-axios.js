#!/usr/bin/env node

// Issue #46: wrap top-level await in try/catch so unhandled rejections
// produce a clean error message + non-zero exit code rather than a raw
// Node stack trace.

import { route } from "../dist/router.js";

try {
	await route(process.argv);
} catch (err) {
	console.error(err && typeof err === "object" && "message" in err ? err.message : String(err));
	process.exit(1);
}
