#!/usr/bin/env node

/**
 * Development entry point for chowbea-axios CLI.
 * Uses ts-node to run TypeScript directly without compilation.
 */

import { execute } from "@oclif/core";

// Enable TypeScript execution for development
process.env.NODE_OPTIONS = "--loader ts-node/esm";

await execute({ development: true, dir: import.meta.url });
