#!/usr/bin/env node

import { route } from "../dist/router.js";

await route(process.argv);
