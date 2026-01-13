#!/usr/bin/env node

/**
 * Production entry point for chowbea-axios CLI.
 * Runs the compiled TypeScript from dist/.
 */

import { execute } from "@oclif/core";

await execute({ dir: import.meta.url });
