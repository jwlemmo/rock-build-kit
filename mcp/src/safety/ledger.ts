/**
 * Ledger reader — turns the append-only audit ledger (logs/changes.jsonl) into the
 * structures rock_restore needs: "what was the effective record for this auditId",
 * "has anything touched this target since", and "load the before-snapshot data".
 *
 * Read-only. Never writes. Resilient to a corrupt/partial trailing line (the process
 * could be killed mid-append) — such lines are skipped and tallied, never thrown.
 */

import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { AUDIT_FILE, SNAPSHOT_DIR } from './audit.js';
import type { AuditRecord } from './types.js';

/** Result of reading the ledger: the parsed records plus a count of skipped bad lines. */
export interface LedgerReadResult {
  records: AuditRecord[];
  skipped: number;
}

/**
 * Read and parse every line of AUDIT_FILE. Missing file → empty result (nothing has been
 * written yet). Blank lines are silently skipped (not counted as corrupt — appendAudit
 * always writes `JSON.stringify(rec) + '\n'`, so a truly empty ledger or a trailing
 * newline is normal). Lines that fail JSON.parse, or parse to something that isn't a
 * plausible AuditRecord (no auditId/phase), are counted in `skipped` and otherwise ignored.
 */
export async function readLedgerRecords(): Promise<AuditRecord[]> {
  const { records } = await readLedgerRecordsWithTally();
  return records;
}

/** Same as readLedgerRecords but also returns the corrupt-line tally, for callers that want it. */
export async function readLedgerRecordsWithTally(): Promise<LedgerReadResult> {
  let text: string;
  try {
    text = await readFile(AUDIT_FILE, 'utf8');
  } catch {
    return { records: [], skipped: 0 }; // no ledger yet
  }

  const records: AuditRecord[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank line (e.g. trailing newline) — not corruption
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).auditId === 'string' &&
        typeof (parsed as Record<string, unknown>).phase === 'string'
      ) {
        records.push(parsed as AuditRecord);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** Every record (any phase) sharing this auditId, oldest-first (ledger append order). */
export function recordsForAuditId(records: AuditRecord[], auditId: string): AuditRecord[] {
  return records.filter((r) => r.auditId === auditId);
}

/**
 * The "effective" record for an auditId: the phase that actually reflects what happened.
 * A given auditId can appear once (preview only — nothing executed) or twice (preview
 * then executed/create — same auditId is reused across phases by rock_edit/rock_delete/
 * upsert_metric_value; rock_create/upsert_metric_value's create path only ever writes one
 * 'create' record). Precedence: 'executed' > 'create' > 'preview'.
 */
export function findLedgerRecord(records: AuditRecord[], auditId: string): AuditRecord | null {
  const matches = recordsForAuditId(records, auditId);
  if (matches.length === 0) return null;
  return (
    matches.find((r) => r.phase === 'executed') ??
    matches.find((r) => r.phase === 'create') ??
    matches.find((r) => r.phase === 'preview') ??
    null
  );
}

/** One conflicting later write, surfaced to the operator in a restore preview. */
export interface LaterWrite {
  auditId: string;
  ts: string;
  tool: string;
  verb: AuditRecord['verb'];
  confidence: 'exact' | 'same-table'; // 'same-table' = SQL record with only a table, no id — a weaker match
}

/**
 * Find executed/create records strictly AFTER `afterTs` that touch the same target as the
 * record being restored, excluding the record's own auditId (and excluding the restore's
 * own audit trail — callers pass their own auditId as excludeAuditId once they have one,
 * but at preview time there isn't one yet, so this only needs to exclude the ORIGINAL
 * record's auditId to avoid it "conflicting with itself").
 *
 * Matching rules:
 *   - When the target has an id, match entityType + id exactly (confidence: 'exact').
 *   - When the target is SQL-mode with only a table (no id — a bulk UPDATE/DELETE, or an
 *     INSERT whose row id we don't track post-hoc), match same-table writes as a WEAKER,
 *     lower-confidence conflict signal (confidence: 'same-table') — the table matches but
 *     we can't prove the same row was touched.
 *   - When the target HAS an id but a later record has NO id and the same entityType:
 *     that later record is a SQL-mode write (they're ledgered with
 *     entityType = normalizeEntityType(table) and no id) — a bulk UPDATE/DELETE that *may*
 *     have touched this row, so it also surfaces as confidence 'same-table'. (REST creates
 *     store the raw plural controller as entityType, so they don't false-match the
 *     normalized singular here.)
 */
export function laterWritesToTarget(
  records: AuditRecord[],
  target: { entityType: string; id?: string | number; table?: string },
  afterTs: string,
  excludeAuditId: string
): LaterWrite[] {
  const afterMs = Date.parse(afterTs);
  const out: LaterWrite[] = [];
  for (const r of records) {
    if (r.auditId === excludeAuditId) continue;
    if (r.phase !== 'executed' && r.phase !== 'create') continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms) || !Number.isFinite(afterMs) || ms <= afterMs) continue;

    const idMatch =
      target.id !== undefined &&
      r.target.entityType === target.entityType &&
      r.target.id !== undefined &&
      String(r.target.id) === String(target.id);
    if (idMatch) {
      out.push({ auditId: r.auditId, ts: r.ts, tool: r.tool, verb: r.verb, confidence: 'exact' });
      continue;
    }

    const tableMatch =
      target.id === undefined &&
      !!target.table &&
      !!r.target.table &&
      r.target.table.toLowerCase() === target.table.toLowerCase();
    if (tableMatch) {
      out.push({ auditId: r.auditId, ts: r.ts, tool: r.tool, verb: r.verb, confidence: 'same-table' });
      continue;
    }

    // Id-target vs a later id-less record of the same entityType: SQL writes carry
    // no per-row id in the ledger, so a later bulk UPDATE/DELETE on this entity's table
    // may have touched the target row — surface it as a lower-confidence conflict.
    const idlessSameType =
      target.id !== undefined &&
      r.target.id == null &&
      r.target.entityType === target.entityType;
    if (idlessSameType) {
      out.push({ auditId: r.auditId, ts: r.ts, tool: r.tool, verb: r.verb, confidence: 'same-table' });
    }
  }
  return out;
}

/** Result of attempting to load a before-snapshot referenced by an AuditRecord.snapshotRef. */
export interface LoadedSnapshot {
  data: unknown | null;
  reason?: string; // set when data is null
}

/**
 * Load a snapshot previously written by writeSnapshotFile. snapshotRef looks like
 * 'logs/snapshots/<name>.json' (repo-relative) or 'inline' (write failed to persist,
 * nothing on disk to load). Resolve via basename() + SNAPSHOT_DIR (not by treating the
 * ref as a path directly) so ROCK_LOGS_DIR/ROCK_AUDIT_FILE overrides — which relocate
 * SNAPSHOT_DIR — are honored instead of chasing the original repo-relative path.
 */
export async function loadSnapshot(snapshotRef: string | undefined): Promise<LoadedSnapshot> {
  if (!snapshotRef) return { data: null, reason: 'no snapshotRef on this record' };
  if (snapshotRef === 'inline') {
    return { data: null, reason: 'snapshot was never persisted to disk (writeSnapshotFile failed at the time) — no before-state to load' };
  }
  const filePath = join(SNAPSHOT_DIR, basename(snapshotRef));
  try {
    const text = await readFile(filePath, 'utf8');
    return { data: JSON.parse(text) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { data: null, reason: `could not load snapshot file ${filePath}: ${msg}` };
  }
}
