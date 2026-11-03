/**
 * Push-process gate: on the dev server, build writes need an open change bundle.
 *
 * The web team's push process (ops/rock-change-management in the Build Kit) records every dev
 * change in a bundle file under the changelog repo's open/ folder, so it can later be reviewed
 * and pushed to production. A session that forgets to open the bundle builds work nobody can
 * see or push. This gate refuses the build-write tools on the dev server until the operator has
 * an open bundle.
 *
 * Scope, deliberately narrow:
 *   - only the dev server (ROCK_API_URL host rock-dev.example.org); production is untouched
 *   - only the build-write tools; data writes (people, groups, attendance...) are not gated
 *   - only operators who have the changelog repo's open/ folder — anyone who has not adopted
 *     the push process works exactly as before
 *   - a bundle counts when its status is "open" and its author matches the operator's email
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveGitIdentity } from './gitIdentity.js';

export const BUNDLE_GATED_TOOLS = new Set([
  'rock_create',
  'rock_edit',
  'rock_delete',
  'create_page_bundle',
  'edit_block_content',
]);

const DEV_HOST = process.env.ROCK_DEV_HOST?.toLowerCase();

/** The changelog repo's open/ folder. ROCK_CHANGELOG_DIR overrides the repo location. */
export function changelogOpenDir(): string {
  const repo = process.env.ROCK_CHANGELOG_DIR ?? join(homedir(), 'Repositories', 'rock-changelog');
  return join(repo, 'open');
}

export function isDevTarget(apiUrl: string | undefined = process.env.ROCK_API_URL): boolean {
  try {
    return new URL(apiUrl ?? '').hostname.toLowerCase() === DEV_HOST;
  } catch {
    return false;
  }
}

/** Returns null when the call may proceed, otherwise the refusal message. */
export function checkBundleGate(tool: string): string | null {
  if (process.env.ROCK_REQUIRE_CHANGE_BUNDLE !== '1' || !BUNDLE_GATED_TOOLS.has(tool) || !isDevTarget()) return null;

  const dir = changelogOpenDir();
  if (!existsSync(dir)) return `Refused: create ${dir} and open a change bundle before writing.`;

  const me = resolveGitIdentity().email.toLowerCase();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const bundle = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (bundle?.status === 'open' && String(bundle?.author ?? '').toLowerCase() === me) return null;
    } catch {
      // an unreadable bundle file is not this operator's open bundle
    }
  }

  return (
    `Refused: ${tool} writes to the dev server, and ${me} has no open change bundle in ${dir}. ` +
    `Every Rock change is recorded in a bundle before the first write (push process: the ` +
    `rock-change-management skill, "Opening a change"). Open the bundle, then retry this call ` +
    `unchanged. Nothing was written.`
  );
}
