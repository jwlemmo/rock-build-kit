/**
 * Resolve the operator's identity for write attribution.
 *
 * Each person has their own Rock REST key, so Rock records who made a write. The local
 * ledger stamps every write with the operator's git identity as well, so the ledger says who
 * ran it without a lookup in Rock. Resolution order:
 *   ROCK_OPERATOR_EMAIL/NAME env  →  `git config user.email`/`user.name`  →  unknown.
 */

import { execSync } from 'node:child_process';
import type { GitIdentity } from './types.js';

let cached: GitIdentity | undefined;

function gitConfig(key: string): string | undefined {
  try {
    const v = execSync(`git config ${key}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export function resolveGitIdentity(): GitIdentity {
  if (cached) return cached;

  const envEmail = process.env.ROCK_OPERATOR_EMAIL;
  if (envEmail) {
    cached = { email: envEmail, name: process.env.ROCK_OPERATOR_NAME ?? envEmail, source: 'env' };
    return cached;
  }

  const email = gitConfig('user.email');
  if (email) {
    cached = { email, name: gitConfig('user.name') ?? email, source: 'git' };
    return cached;
  }

  cached = { email: 'unknown@unattributed', name: 'unknown', source: 'unknown' };
  return cached;
}

/** Test-only: clear the cached identity. */
export function _resetGitIdentityCache(): void {
  cached = undefined;
}
