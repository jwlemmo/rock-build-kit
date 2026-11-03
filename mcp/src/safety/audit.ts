/**
 * Append-only audit ledger for Rock writes — the authoritative record of what changed
 * and the basis for revert. Distinct from logger.ts (which only *summarizes* every tool
 * call): this logs writes only, with full payloads, the before-snapshot reference, the
 * operator, and the confirmation token.
 *
 * Files (all under logs/, which is gitignored so member data + before-images never enter git):
 *   - logs/changes.jsonl     append-only ledger (override with ROCK_AUDIT_FILE)
 *   - logs/snapshots/<id>.json   before-state for each edit/delete
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Compiled location is <repo>/dist/safety/audit.js, so ../../logs lands at <repo>/logs.
const LOGS_DIR = process.env.ROCK_LOGS_DIR ?? join(__dirname, '..', '..', 'logs');
const AUDIT_FILE = process.env.ROCK_AUDIT_FILE ?? join(LOGS_DIR, 'changes.jsonl');
const SNAPSHOT_DIR = join(LOGS_DIR, 'snapshots');

try {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
} catch {
  // best-effort; the write functions guard again
}

/**
 * Append one audit record. Unlike the usage logger this is awaited and reports success,
 * because it is the revert source of truth. Never throws — returns false on failure so the
 * caller can surface a warning without losing the (already-applied) operation.
 */
export async function appendAudit(rec: AuditRecord): Promise<boolean> {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    await appendFile(AUDIT_FILE, JSON.stringify(rec) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Persist a before-snapshot to logs/snapshots/<auditId>.json; returns its repo-relative ref. */
export async function writeSnapshotFile(auditId: string, data: unknown): Promise<string> {
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(join(SNAPSHOT_DIR, `${auditId}.json`), JSON.stringify(data, null, 2));
    return `logs/snapshots/${auditId}.json`;
  } catch {
    return 'inline'; // snapshot is still returned inline in the preview
  }
}

export { AUDIT_FILE, SNAPSHOT_DIR };
