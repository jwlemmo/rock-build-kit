/**
 * The safety layer for the older data-write tools (update_person, add_group_member, ...).
 *
 * Same rule as rock_create / rock_edit / rock_delete:
 *   - creates (add_*, record_*, create_*, launch_workflow) run at once and are ledgered as
 *     phase 'create', with the new row's Id so rock_restore can undo them where possible;
 *   - edits and removals (update_*, remove_*, set_person_attribute) are two-phase: the first
 *     call returns the intended change, the before-state and a confirmation_token, and writes
 *     nothing; the same call again with the token executes and is ledgered as phase 'executed'
 *     with the before-snapshot on disk.
 *
 * Each tool supplies a `prepare` function that does its read-only lookups (find the tagged
 * item, the phone row, the group member...) and returns a PreparedWrite: what it will write,
 * the before-state, how rock_restore can undo it, and an `apply` that performs the write.
 * prepare runs on both phases, so the execute call re-reads current state rather than trusting
 * the preview, and the token covers the looked-up target id — if the target changed between
 * preview and execute, the token no longer matches.
 *
 * Ledger shapes are chosen so rock_restore's existing plans apply:
 *   create with result.newId           → undo = DELETE controller/{newId}
 *   edit with payload.body + snapshot  → undo = PATCH the snapshot's values for body's keys
 *   delete with payload.action deleted → undo = re-POST the snapshot (new Id, same Guid)
 *   delete with payload.action archived→ undo = PATCH IsArchived back to the snapshot's value
 * and record.undo marks the cases with no undo (launch_workflow) or a custom one
 * (set_person_attribute).
 */

import { createHash } from 'node:crypto';
import { appendAudit, writeSnapshotFile } from './audit.js';
import { resolveGitIdentity } from './gitIdentity.js';
import { deriveToken, validateToken } from './confirm.js';
import { WriteRefused, enforceBulkCap, readBack, UNCERTAIN_OUTCOME_NOTE } from './writeGuard.js';
import type { AuditRecord, Verb, WriteOp } from './types.js';

/** Tools that are two-phase by policy (decided by the tool, not by what the lookup finds). */
const TWO_PHASE_TOOLS = new Set([
  'update_person',
  'update_person_address',
  'update_person_phone',
  'remove_person_tag',
  'set_person_attribute',
  'remove_group_member',
  'update_group',
  'update_reservation',
]);

export interface AppliedWrite {
  /** The tool's own result fields (kept from the pre-hardening return shape). */
  result: Record<string, unknown>;
  /** create: the new row's Id (what rock_restore deletes to undo it). */
  newId?: string | number;
  /** delete: what actually happened to the row. */
  action?: 'deleted' | 'archived';
  /** Other rows the call created (each gets its own ledger record so it can be undone separately). */
  extraCreates?: Array<{ entityType: string; id: string | number; body?: unknown; label: string }>;
  /** Re-read the target after the write. */
  readBack: () => Promise<{ verified: boolean; after?: unknown; note?: string }>;
}

export interface PreparedWrite {
  /** What the write actually is once the lookups are done (update_person_phone may create). */
  verb: Verb;
  /** Singular Rock entity type of the row written (Person, GroupMember, TaggedItem...). */
  entityType: string;
  /** Id of the existing row (edit/delete). */
  id?: string | number;
  /** PascalCase fields the write sets on an existing row — the keys rock_restore patches back. */
  body?: Record<string, unknown>;
  /** Before-state of the row (edit/delete), in the v1 shape rock_restore reads. */
  before?: unknown;
  /** Human description of the change, shown in the preview. */
  intended: unknown;
  /** Rows the call will touch (bulk cap). Default 1. */
  rowCount?: number;
  /** Nothing to do (e.g. already a member): returned as-is, nothing written or ledgered. */
  noop?: Record<string, unknown>;
  /** How rock_restore can undo this, or why it cannot. */
  undo?: AuditRecord['undo'];
  notes?: string[];
  /** Performs the write. Omit only together with noop. */
  apply?: () => Promise<AppliedWrite>;
}

function nowIso(): string {
  return new Date().toISOString();
}
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Call args that define the operation (no token / tag / label / reason — reason enters the token separately). */
function opArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'confirmation_token' || k === 'session_tag' || k === 'label' || k === 'reason') continue;
    out[k] = v;
  }
  return out;
}

export async function runLegacyWrite(
  tool: string,
  rawArgs: unknown,
  prepare: () => Promise<PreparedWrite>
): Promise<Record<string, unknown>> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const token = typeof args.confirmation_token === 'string' ? args.confirmation_token : undefined;
  const label = typeof args.label === 'string' ? args.label : undefined;
  const operator = resolveGitIdentity();
  const ts = nowIso();
  const twoPhase = TWO_PHASE_TOOLS.has(tool);

  const prepared = await prepare();
  const target: AuditRecord['target'] = { entityType: prepared.entityType, id: prepared.id };
  if (prepared.noop) {
    return { ...prepared.noop, written: false };
  }
  const apply = prepared.apply;
  if (!apply) throw new Error(`${tool}: internal error — prepared write has neither noop nor apply.`);
  enforceBulkCap(prepared.rowCount ?? 1, `${tool} call`, target);

  const op: WriteOp = {
    verb: prepared.verb,
    mode: 'rest',
    controller: tool,
    id: prepared.id,
    body: { args: opArgs(args), write: prepared.body ?? null },
  };
  const expected = deriveToken(op);

  // ---- two-phase, first call: preview only ----
  if (twoPhase && !token) {
    const auditId = shortHash(expected);
    await appendAudit({
      auditId, ts, phase: 'preview', operator, tool, verb: prepared.verb, mode: 'rest', target,
      payload: { label, args: opArgs(args), body: prepared.body }, confirmationToken: expected,
      undo: prepared.undo, result: { success: true },
    });
    return {
      phase: 'preview',
      tool,
      verb: prepared.verb,
      target,
      intended_change: prepared.intended,
      rows_affected: prepared.rowCount ?? 1,
      before_snapshot: prepared.before,
      undo: prepared.undo ?? { supported: true, how: 'rock_restore with this call\'s auditId after it executes' },
      notes: prepared.notes,
      confirmation_token: expected,
      next_step:
        `STOP. Show the user the intended change and before-snapshot above. Only after they approve, re-call ${tool} ` +
        'with the SAME arguments (including the same reason) plus this confirmation_token to execute.',
      operator,
    };
  }

  // ---- two-phase, second call: token must match the re-prepared operation ----
  if (twoPhase && !validateToken(op, token)) {
    throw new WriteRefused(
      `Confirmation token mismatch for ${tool} — the arguments or reason changed since the preview, the target ` +
        `changed in Rock, or the preview was skipped. Nothing was written. Re-call ${tool} WITHOUT a token to get a fresh preview.`,
      target
    );
  }

  const auditId = twoPhase ? shortHash(expected) : shortHash(`${tool}|create|${JSON.stringify(opArgs(args))}|${ts}`);
  const snapshotRef =
    prepared.before !== undefined ? await writeSnapshotFile(`${auditId}-before`, prepared.before) : undefined;
  const phase: AuditRecord['phase'] = twoPhase ? 'executed' : 'create';

  let applied: AppliedWrite;
  try {
    applied = await apply();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The write call itself failed partway — it may or may not have landed. Ledger that, never retry.
    await appendAudit({
      auditId, ts, phase, operator, tool, verb: prepared.verb, mode: 'rest', target, snapshotRef,
      payload: { label, args: opArgs(args), body: prepared.body }, confirmationToken: token, undo: prepared.undo,
      result: { success: false, error: msg.slice(0, 500), verified: false },
    });
    throw new Error(`${tool}: the write failed (${msg}). ${UNCERTAIN_OUTCOME_NOTE} Ledger auditId ${auditId}.`);
  }

  const rb = await readBack(applied.readBack);
  const action = prepared.verb === 'delete' ? applied.action ?? 'deleted' : undefined;
  const ledgerTarget: AuditRecord['target'] =
    prepared.verb === 'create' && applied.newId !== undefined ? { entityType: prepared.entityType, id: applied.newId } : target;
  const auditLogged = await appendAudit({
    auditId, ts, phase, operator, tool, verb: prepared.verb, mode: 'rest', target: ledgerTarget, snapshotRef,
    payload: {
      label,
      args: opArgs(args),
      body: prepared.body,
      action,
      alsoCreated: applied.extraCreates?.map((x) => ({ entityType: x.entityType, id: x.id, label: x.label })),
    },
    confirmationToken: token, undo: prepared.undo,
    result: { success: true, newId: applied.newId, verified: rb.verified },
  });

  const extraAuditIds: string[] = [];
  for (const [i, x] of (applied.extraCreates ?? []).entries()) {
    const xid = `${auditId}-${i + 1}`;
    await appendAudit({
      auditId: xid, ts, phase, operator, tool, verb: 'create', mode: 'rest', target: { entityType: x.entityType, id: x.id },
      payload: { label: `${label ?? tool} — ${x.label}`, body: x.body, partOf: auditId },
      result: { success: true, newId: x.id },
    });
    extraAuditIds.push(xid);
  }

  return {
    ...applied.result,
    ...(twoPhase ? { phase: 'executed' } : {}),
    written: true,
    verified: rb.verified,
    after: rb.after,
    verification_note: rb.verification_note,
    before_snapshot_ref: snapshotRef,
    auditId,
    also_created_audit_ids: extraAuditIds.length ? extraAuditIds : undefined,
    undo: prepared.undo ?? { supported: true, how: `rock_restore with audit_id "${auditId}"` },
    auditLogged,
    operator,
  };
}
