#!/usr/bin/env node
/**
 * Generates src/generated/build-info.ts — embeds the git identity of the source tree this
 * dist/ is compiled from, so a long-lived server process (and any MCP client talking to it)
 * can answer "what build am I talking to" without guessing from file mtimes.
 *
 * Why this exists (P4 task 4 / reference/rock-sessions-lessons-2026-08-15.md L2): rock-v2,
 * rock-rms-v2, and rock-dev are long-lived node processes — each keeps whatever dist/ existed
 * at the moment IT started. On 2026-08-07 the two aliases returned DIFFERENT errors for the
 * identical bad flush_cache call because one process was still serving yesterday's build.
 * `npm run build` alone does not reach an already-running process; the running process has to
 * be restarted (the operator's call) before a rebuild takes effect. This file lets a session ask the
 * server directly instead of assuming a rebuild landed.
 *
 * Runs as the FIRST step of `npm run build` and `npm run dev`, before `tsc` — no dependencies
 * beyond node:child_process + node:fs (the July 2026 npm-ci-only pin stays untouched).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function git(cmd, fallback) {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

const sha = git('git rev-parse --short=12 HEAD', 'unknown');
const shaFull = git('git rev-parse HEAD', 'unknown');
const branch = git('git rev-parse --abbrev-ref HEAD', 'unknown');
// Non-empty `git status --porcelain` means uncommitted changes were present at build time —
// exactly the state that makes "which build is this" ambiguous even with a sha in hand.
const dirty = git('git status --porcelain', '') !== '';
const buildTime = new Date().toISOString();

const outDir = join(repoRoot, 'src', 'generated');
mkdirSync(outDir, { recursive: true });

const contents = `/**
 * GENERATED at build time by scripts/gen-build-info.mjs — do not hand-edit; it is
 * regenerated (and gitignored) on every \`npm run build\` / \`npm run dev\`.
 */
export const BUILD_SHA = ${JSON.stringify(sha)};
export const BUILD_SHA_FULL = ${JSON.stringify(shaFull)};
export const BUILD_BRANCH = ${JSON.stringify(branch)};
export const BUILD_DIRTY = ${dirty ? 'true' : 'false'};
export const BUILD_TIME = ${JSON.stringify(buildTime)};
`;

writeFileSync(join(outDir, 'build-info.ts'), contents);
console.error(`[gen-build-info] ${sha}${dirty ? '-dirty' : ''} (${branch}) @ ${buildTime}`);
