/**
 * parseBuildArgs() — the corpora's `--go` CLI convention, generalized.
 * See index.ts for the module overview.
 */

import type { ParsedBuildArgs } from './types.js';

/**
 * Parse a build script's argv (pass `process.argv.slice(2)`). Mirrors
 * 13-cleanup-test-data.mjs:16 (`const GO = process.argv.includes('--go')`) and deploy.mjs's
 * multi-flag argv Set (deploy.mjs:29 `const ARG = new Set(process.argv.slice(2))`) — `go`
 * is pulled out as the one flag this library's write gate cares about; every other token is
 * returned verbatim in `flags` for the script's own flag handling (e.g. deploy.mjs's
 * --update-user/--deploy-admin/--all).
 */
export function parseBuildArgs(argv: string[]): ParsedBuildArgs {
  const go = argv.includes('--go');
  const flags = argv.filter((a) => a !== '--go');
  return { go, flags };
}
