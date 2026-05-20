#!/usr/bin/env node
/**
 * Binary stub. Compiled JS at `dist/src/cli.js` is the source of truth —
 * this file just forwards argv and exit code. The compiler keeps the
 * `src/` and `test/` layout under `dist/` because `rootDir` is the repo
 * root; that's deliberate so the unified-report adapter tests can import
 * compiled samples without path gymnastics.
 *
 * The package.json `bin` field points here so `npx rskj-regression` and
 * a global `npm install -g .` both work.
 */

import { main } from "../dist/src/cli.js";

const result = await main({ argv: process.argv.slice(2) });
process.exit(result.exitCode);
