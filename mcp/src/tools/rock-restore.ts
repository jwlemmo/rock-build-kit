/**
 * rock_restore — undo a past ledgered write. THE undo tool for rock_create/rock_edit/
 * rock_delete/upsert_metric_value.
 *
 * Restoring is itself an edit/delete (a PATCH-back, a re-create POST, or an undo-create
 * DELETE), so it uses the SAME two-phase preview/confirmation_token handshake as rock_edit
 * — a HARD-STOP, two-phase action. There are no exceptions: even a "recreate" (which looks
 * like a create) goes through preview → STOP → confirm, because unlike rock_create it is
 * reversing someone else's prior write, not a fresh, obviously-safe addition.
 *
 * Modes:
 *   - LIST (no audit_id): browse the last N ledgered writes, each flagged restorable/why_not.
 *     Read-only — no ledger writes, no confirmation_token.
 *   - PREVIEW/EXECUTE (audit_id present): classify the ledgered record into a restore plan
 *     (see classifyRestore below), then run the same preview → token → execute handshake
 *     as rock_edit. Phase 1 (no confirmation_token) captures current state, runs impact
 *     analysis on destructive paths, checks for staleness (later writes to the same target)
 *     and no-ops, and returns a token. Phase 2 (token matches) RE-CHECKS staleness — a
 *     write can land in the gap between preview and confirm; force:true (baked into the
 *     token) authorizes overwriting later changes — and then executes.
 *
 * Restore plan classification (case letters match the design doc):
 *   a. preview-only record            → refuse (nothing was executed)
 *   b. REST/SQL create (has newId)    → undo-create: hard DELETE controller/{newId}
 *   c. REST edit executed             → patch-back: PATCH {key: snapshot[key]} per changed key
 *   d. delete executed, deactivated   → reactivate: PATCH {IsActive: true}
 *   e. delete executed, hard-deleted  → recreate: POST a cleaned copy of the snapshot
 *   f. SQL create with newId+table    → undo-create SQL: DELETE FROM [table] WHERE Id = newId
 *   g. SQL edit/delete executed       → refuse (v1 scope cut — see below)
 *   h. anything else (flush_cache…)   → refuse
 *
 * Scope cuts (v1), called out here and in the tool description so they're not mistaken for
 * bugs:
 *   - No SQL edit/delete restore. A SQL UPDATE/DELETE's snapshot is a raw row capture with
 *     no reliable generic "undo SQL" (unlike REST, there's no single controller/{id} PATCH
 *     target). The preview instead returns the snapshotRef + inline data and tells the
 *     operator to restore manually via rock_edit/rock_create.
 *   - No manifest.json mutation. A restore that undoes a rock_create does not remove the
 *     entry recordCreated() added — the manifest is an idempotency aid for the ORIGINAL
 *     build, not a live inventory; pruning it here would be surprising action-at-a-distance.
 *   - No automatic cache flush. When the target entity type is cache-sensitive (HtmlContent,
 *     AttributeValue, Block, Page) the response mentions flush_cache; it does not call it.
 *   - No relinking of numeric-Id references after a recreate. A recreated row gets a NEW
 *     Id (only its Guid is preserved) — anything that pointed to the old numeric Id
 *     elsewhere in Rock will NOT follow. The preview warns about this explicitly.
 */

import { createHash } from 'node:crypto';
import { RockClient } from '../rock-client.js';
import { validateWrite } from '../sql-write-validator.js';
import {
  resolveGitIdentity,
  appendAudit,
  writeSnapshotFile,
  deriveToken,
  validateToken,
  runImpact,
  normalizeEntityType,
  readLedgerRecords,
  findLedgerRecord,
  laterWritesToTarget,
  loadSnapshot,
  type WriteOp,
  type ImpactTarget,
  type AuditRecord,
} from '../safety/index.js';

// ---------------------------------------------------------------- helpers (mirrors rock-write.ts)

function nowIso(): string {
  return new Date().toISOString();
}
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Compact JSON for human-facing summaries (list-mode restore_action, planned_action, ledger
 * payload summaries) — capped so a large body (e.g. a full HtmlContent Content blob) can't
 * bloat every list response. The FULL body always travels untruncated in intended_change
 * and in the confirmation-token op, which is what actually executes.
 */
function truncateJson(value: unknown, max = 200): string {
  const s = JSON.stringify(value) ?? 'null';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Cache-sensitive entity types where flush_cache is worth mentioning (not calling — see scope cuts).
const CACHE_SENSITIVE_TYPES = new Set(['HtmlContent', 'AttributeValue', 'Block', 'Page']);

function cacheHint(entityType: string): string | undefined {
  if (!CACHE_SENSITIVE_TYPES.has(entityType)) return undefined;
  return `${entityType} is cache-sensitive — consider calling flush_cache after this restore to make the change visible.`;
}

/**
 * Invert normalizeEntityType: map a singular entity type back to its REST controller name.
 *
 * Defensive normalization: the real ledger contains historical records written before
 * rock_create's REST path was fixed to store a normalized (singular) entityType — those
 * records have an already-PLURAL entityType (e.g. "Blocks", "Auths") ledgered directly from
 * the raw controller param. Running entityType through normalizeEntityType() first makes this
 * function idempotent to that historical shape: a plural in ("Blocks") normalizes to singular
 * ("Block") before pluralizing back to "Blocks", instead of double-pluralizing to "Blockss".
 * normalizeEntityType() is a no-op on values that are already singular (verified for every
 * entityType/controller form actually used in this codebase), so well-formed callers are
 * unaffected.
 */
function controllerFromEntityType(entityType: string): string {
  const singular = normalizeEntityType(entityType);
  const irregular: Record<string, string> = {
    Person: 'People',
    Page: 'Pages',
    Block: 'Blocks',
    Attribute: 'Attributes',
    AttributeValue: 'AttributeValues',
    WorkflowType: 'WorkflowTypes',
    WorkflowActionType: 'WorkflowActionTypes',
    WorkflowActivityType: 'WorkflowActivityTypes',
    DefinedValue: 'DefinedValues',
    DefinedType: 'DefinedTypes',
    Group: 'Groups',
    Category: 'Categories',
    PageRoute: 'PageRoutes',
  };
  if (irregular[singular]) return irregular[singular];
  // Generic pluralize, mirroring normalizeEntityType's generic singularize inverse.
  if (/[^aeiou]y$/i.test(singular)) return singular.replace(/y$/i, 'ies');
  return `${singular}s`;
}

/** Properties stripped from a snapshot before re-POSTing it (recreate path, case e). */
const STRIP_ON_RECREATE = new Set([
  'Id',
  'CreatedDateTime',
  'ModifiedDateTime',
  'CreatedByPersonAliasId',
  'ModifiedByPersonAliasId',
]);

/** Build the cleaned re-create body: strip audit/Id fields and any nav (array/object) props. Keeps Guid. */
function cleanForRecreate(snapshot: Record<string, unknown>): { body: Record<string, unknown>; droppedNav: string[] } {
  const body: Record<string, unknown> = {};
  const droppedNav: string[] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (STRIP_ON_RECREATE.has(key)) continue;
    if (value !== null && typeof value === 'object') {
      // Navigation property (array or nested object) — not a plain scalar column. Drop it;
      // Rock will refuse an unexpected shape on POST, and these aren't restorable generically.
      droppedNav.push(key);
      continue;
    }
    body[key] = value;
  }
  return { body, droppedNav };
}

function shallowEqual(current: Record<string, unknown>, target: Record<string, unknown>): boolean {
  for (const key of Object.keys(target)) {
    // Loose equality on purpose: Rock round-trips numbers/booleans through REST in ways
    // that can flip string<->number representation (e.g. "2" vs 2); a no-op check should
    // not false-negative on that.
    // eslint-disable-next-line eqeqeq
    if (current[key] != target[key]) return false;
  }
  return true;
}

// ================================================================ restore-plan classification

export type RestorePlan =
  | { kind: 'refuse'; reason: string }
  | {
      kind: 'undo-create';
      mode: 'rest';
      controller: string;
      id: string | number;
      entityType: string;
    }
  | {
      kind: 'undo-create';
      mode: 'sql';
      table: string;
      id: string | number;
    }
  | {
      kind: 'patch-back';
      controller: string;
      id: string | number;
      entityType: string;
      body: Record<string, unknown>;
      warnings: string[];
    }
  | {
      kind: 'reactivate';
      controller: string;
      id: string | number;
      entityType: string;
    }
  | {
      kind: 'recreate';
      controller: string;
      entityType: string;
      body: Record<string, unknown>;
      guid?: string;
      droppedNav: string[];
    }
  | { kind: 'sql-refuse'; entityType: string; table?: string; snapshotRef?: string; snapshot: unknown };

/**
 * Classify a ledger record's restore plan. Pure with respect to network — the only async
 * work is loading the snapshot file. Shared by list mode (to report restorable/why_not) and
 * preview/execute mode (to build the actual plan). See file header for the case lettering.
 */
export async function classifyRestore(effective: AuditRecord): Promise<RestorePlan> {
  const { tool, verb, mode, target, payload, result } = effective;

  // case a — only a preview was ever ledgered; nothing executed, nothing to undo.
  if (effective.phase === 'preview') {
    return { kind: 'refuse', reason: 'Only a preview was ledgered for this auditId — nothing was ever executed, so there is nothing to restore.' };
  }

  // case h — tools with no restore story (flush_cache, launch_workflow, etc. never reach
  // this ledger at all today, but guard generically on verb/mode so future non-restorable
  // tools fail closed instead of falling through to a wrong branch).
  if (verb !== 'create' && verb !== 'edit' && verb !== 'delete') {
    return { kind: 'refuse', reason: `Tool "${tool}" wrote a ledger record with verb "${String(verb)}", which rock_restore does not know how to reverse.` };
  }

  // ---- create records: rock_create, upsert_metric_value (phase 'create'), or a prior
  // rock_restore recreate (which self-describes as a create-shaped record, see below).
  if (verb === 'create') {
    const newId = result?.newId;
    if (mode === 'rest') {
      if (newId === undefined || newId === null) {
        return { kind: 'refuse', reason: 'This create record has no result.newId on record — cannot identify the row to undo-create (DELETE).' };
      }
      return { kind: 'undo-create', mode: 'rest', controller: controllerFromEntityType(target.entityType), id: newId, entityType: target.entityType };
    }
    // mode === 'sql'
    if (newId === undefined || newId === null || !target.table) {
      return {
        kind: 'refuse',
        reason: 'This SQL create record is missing result.newId or target.table — cannot build a safe DELETE FROM [table] WHERE Id = <newId>. Restore manually.',
      };
    }
    // Undo-create SQL hardening: the Id must be a real finite number (never emit
    // `WHERE Id = NaN`), and the DELETE we would emit must clear the same write-SQL gate
    // rock_delete uses — a hostile or corrupt table name in a ledger record must not
    // reach SQL Server. Validating here (not just at execute) keeps list mode honest too.
    const idNum = Number(newId);
    if (!Number.isFinite(idNum)) {
      return {
        kind: 'refuse',
        reason: `This SQL create record's result.newId (${JSON.stringify(newId)}) is not numeric — refusing to build a DELETE with a non-numeric Id. Restore manually.`,
      };
    }
    const undoSql = `DELETE FROM [${target.table}] WHERE Id = ${idNum}`;
    const undoCheck = validateWrite(undoSql, 'delete');
    if (!undoCheck.valid) {
      return { kind: 'refuse', reason: `SQL write rejected: ${undoCheck.error}` };
    }
    return { kind: 'undo-create', mode: 'sql', table: target.table, id: idNum };
  }

  // ---- edit records: rock_edit (mode rest/sql), upsert_metric_value 'executed', or a
  // prior rock_restore patch-back (self-describes the same shape, see execute-phase below).
  if (verb === 'edit') {
    if (mode === 'sql') {
      // case g — SQL edit restore is a documented v1 scope cut.
      const snap = await loadSnapshot(effective.snapshotRef);
      return { kind: 'sql-refuse', entityType: target.entityType, table: target.table, snapshotRef: effective.snapshotRef, snapshot: snap.data ?? snap.reason };
    }
    // case c — REST edit: restore key set depends on which tool wrote the record.
    if (target.id === undefined || target.id === null) {
      return { kind: 'refuse', reason: 'This edit record has no target.id — cannot identify the row to patch back.' };
    }
    const controller = controllerFromEntityType(target.entityType);
    const warnings: string[] = [];
    let restoreKeys: string[];
    if (tool === 'upsert_metric_value') {
      // Verified in metrics.ts: the update path PATCHes exactly { YValue, [Note] } —
      // MetricValueDateTime is never touched on update (only set at create time). The task
      // brief guessed "YValue + MetricValueDateTime"; the code says otherwise, so restore
      // keys are YValue always, plus Note only when the executed payload included it.
      restoreKeys = ['YValue'];
      const p = payload as { note?: string } | undefined;
      if (p && Object.prototype.hasOwnProperty.call(p, 'note') && p.note !== undefined) restoreKeys.push('Note');
    } else {
      // rock_edit and rock_restore patch-back records both self-describe as { label, body }.
      const p = payload as { body?: Record<string, unknown> } | undefined;
      restoreKeys = p?.body ? Object.keys(p.body) : [];
      if (restoreKeys.length === 0) {
        return { kind: 'refuse', reason: `Edit record's payload has no body — cannot determine which fields to restore for ${tool}.` };
      }
    }
    const snap = await loadSnapshot(effective.snapshotRef);
    if (snap.data === null || typeof snap.data !== 'object') {
      return { kind: 'refuse', reason: `Could not load the before-snapshot for this edit (${snap.reason ?? 'unknown'}) — cannot build the restore PATCH body.` };
    }
    const snapshot = snap.data as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    for (const key of restoreKeys) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        body[key] = snapshot[key];
      } else {
        body[key] = null;
        warnings.push(`Key "${key}" was not present in the before-snapshot — restoring it to null. Verify this is correct before confirming.`);
      }
    }
    return { kind: 'patch-back', controller, id: target.id, entityType: target.entityType, body, warnings };
  }

  // ---- delete records: rock_delete (mode rest/sql), or a prior rock_restore reactivation
  // (self-describes the same {label, body:{IsActive:true}} shape as a patch-back — so an
  // "undo of a restore-reactivation" is itself just another patch-back, handled above via
  // tool !== 'upsert_metric_value' branch... but a *delete*-verb record never reaches here
  // as an edit; this comment documents why case d/e branch on the DELETE record itself.)
  if (mode === 'sql') {
    // case g — SQL delete restore is a documented v1 scope cut (same reasoning as edit).
    const snap = await loadSnapshot(effective.snapshotRef);
    return { kind: 'sql-refuse', entityType: target.entityType, table: target.table, snapshotRef: effective.snapshotRef, snapshot: snap.data ?? snap.reason };
  }
  if (target.id === undefined || target.id === null) {
    return { kind: 'refuse', reason: 'This delete record has no target.id — cannot identify the row to restore.' };
  }
  const controller = controllerFromEntityType(target.entityType);
  const p = payload as { action?: 'deactivated' | 'deleted'; hard?: boolean } | undefined;
  if (p?.action === 'deactivated') {
    // case d
    return { kind: 'reactivate', controller, id: target.id, entityType: target.entityType };
  }
  // case e — hard delete: recreate from the snapshot.
  const snap = await loadSnapshot(effective.snapshotRef);
  if (snap.data === null || typeof snap.data !== 'object') {
    return { kind: 'refuse', reason: `Could not load the before-snapshot for this delete (${snap.reason ?? 'unknown'}) — cannot recreate the row.` };
  }
  const { body, droppedNav } = cleanForRecreate(snap.data as Record<string, unknown>);
  const guid = typeof body.Guid === 'string' ? body.Guid : undefined;
  return { kind: 'recreate', controller, entityType: target.entityType, body, guid, droppedNav };
}

/** Human-readable one-liner for a classified plan, used by both list mode and preview mode. */
function describePlan(plan: RestorePlan): { restorable: boolean; restore_action?: string; why_not?: string } {
  switch (plan.kind) {
    case 'refuse':
      return { restorable: false, why_not: plan.reason };
    case 'sql-refuse':
      return {
        restorable: false,
        why_not:
          'SQL-mode edit/delete restore is not supported in v1 — the snapshot is available but you must restore manually via rock_edit/rock_create.',
      };
    case 'undo-create':
      return {
        restorable: true,
        restore_action:
          plan.mode === 'rest'
            ? `Hard DELETE ${plan.controller}/${plan.id} (undo the create).`
            : `DELETE FROM [${plan.table}] WHERE Id = ${plan.id} (undo the SQL create).`,
      };
    case 'patch-back':
      // Truncated: a patch-back body can carry an entire HtmlContent blob — the full body
      // belongs in the preview's intended_change, never in every list-mode row.
      return { restorable: true, restore_action: `PATCH ${plan.controller}/${plan.id} with ${truncateJson(plan.body)} (restore previous values).` };
    case 'reactivate':
      return { restorable: true, restore_action: `PATCH ${plan.controller}/${plan.id} with {"IsActive":true} (reactivate).` };
    case 'recreate':
      return { restorable: true, restore_action: `Re-POST a cleaned copy of the before-snapshot to ${plan.controller} (recreate the deleted row; new Id, same Guid).` };
  }
}

// ================================================================ rock_restore

export interface RockRestoreParams {
  audit_id?: string;
  recent?: number;
  confirmation_token?: string;
  force?: boolean;
  label?: string;
  session_tag?: string;
}

export const rockRestoreSchema = {
  name: 'rock_restore',
  description:
    'UNDO a past ledgered write — the inverse of rock_edit/rock_delete/rock_create/upsert_metric_value. ' +
    'A HARD-STOP, two-phase action, same handshake as rock_edit: call WITHOUT audit_id first to LIST the ' +
    'last N ledgered writes (each flagged restorable / restore_action or why_not, no writes, no token). ' +
    'Pick an auditId, then call WITH audit_id and WITHOUT confirmation_token to get a PREVIEW: the planned ' +
    'restore action, current vs. before state, any later conflicting writes to the same target, an impact ' +
    'analysis for destructive paths, and a confirmation_token. STOP and show the user the preview; only ' +
    'after they approve, re-call with the SAME arguments plus the confirmation_token to execute. ' +
    'Restore plans: undoing a create hard-DELETEs the created row; undoing an edit PATCHes the old values ' +
    'back; undoing a deactivation PATCHes IsActive:true; undoing a hard delete RE-CREATES a cleaned copy of ' +
    'the snapshot (new Id, same Guid — numeric-Id references elsewhere will NOT be relinked). If a later ' +
    'write touched the same target since the original record, the preview will not return a token unless ' +
    'force:true is also passed (acknowledging you may be overwriting that later change) — re-call with ' +
    'force:true to get a token that authorizes exactly that. If the current state already matches the ' +
    'restore target, you get phase:"noop" instead of a token (nothing to do). ' +
    'Scope cuts (v1): SQL-mode edit/delete restore is refused (snapshot is returned for manual restore via ' +
    'rock_edit/rock_create); manifest.json is never modified; no automatic cache flush (the response names ' +
    'flush_cache when the target is cache-sensitive); recreated rows are not relinked by their old numeric Id.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      audit_id: { type: 'string', description: 'The auditId (from list mode, or from any tool\'s prior response) to restore. Omit to list recent restorable writes instead.' },
      recent: { type: 'number', description: 'List mode only: how many recent ledgered writes to show (default 15).' },
      confirmation_token: { type: 'string', description: 'Omit on the preview call; pass the returned token on the execute call.' },
      force: { type: 'boolean', description: 'Acknowledge and proceed even though a later write touched the same target since this record. Must match between preview and execute (it is part of the token).' },
      label: { type: 'string', description: 'Optional human label recorded in the audit ledger for this restore.' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on the audit ledger entry alongside the ' +
          'operator\'s git identity, so "did my session touch prod?" is answerable later.',
      },
    },
  },
};

// ---------------------------------------------------------------- list mode

interface ListedEntry {
  auditId: string;
  ts: string;
  tool: string;
  verb: AuditRecord['verb'];
  mode: AuditRecord['mode'];
  target: AuditRecord['target'];
  description: string;
  restorable: boolean;
  restore_action?: string;
  why_not?: string;
}

function describeTarget(rec: AuditRecord): string {
  const label = (rec.payload as { label?: string } | undefined)?.label;
  if (label) return label;
  const t = rec.target;
  if (t.id !== undefined && t.id !== null) return `${t.entityType} #${t.id}`;
  if (t.table) return `table ${t.table}`;
  return t.entityType || 'unknown target';
}

async function listRecent(recent: number): Promise<unknown> {
  const all = await readLedgerRecords();
  // "Effective" records only (executed/create) — a bare preview never became a real write,
  // so it's not a restore candidate for list purposes (though case (a) still explains why
  // if someone passes that auditId directly).
  const effectiveOnly = all.filter((r) => r.phase === 'executed' || r.phase === 'create');
  // Newest first, by ts.
  effectiveOnly.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const slice = effectiveOnly.slice(0, recent);

  const entries: ListedEntry[] = [];
  for (const rec of slice) {
    const plan = await classifyRestore(rec);
    const { restorable, restore_action, why_not } = describePlan(plan);
    entries.push({
      auditId: rec.auditId,
      ts: rec.ts,
      tool: rec.tool,
      verb: rec.verb,
      mode: rec.mode,
      target: rec.target,
      description: describeTarget(rec),
      restorable,
      restore_action,
      why_not,
    });
  }
  return {
    mode: 'list',
    count: entries.length,
    entries,
    next_step: entries.length
      ? 'Pick an auditId with restorable:true, then call rock_restore with that audit_id (no confirmation_token) to get a preview.'
      : 'No ledgered writes found yet.',
  };
}

// ---------------------------------------------------------------- preview/execute mode

/**
 * Fetch current REST state for a no-op / current_state comparison. Returns null ONLY on a
 * genuine 404 (the row is gone); any other failure (5xx, timeout, auth) is RETHROWN.
 * Conflating "absent" with "failed" here would let a transient error read as "already
 * restored — nothing to do", which is a wrong answer from a safety tool. 404 detection
 * matches captureRestSnapshot's: the client formats errors as `Rock v1 GET path → status: …`.
 */
async function tryGetCurrent(client: RockClient, controller: string, id: string | number): Promise<unknown | null> {
  try {
    return await client.v1Get<unknown>(`${controller}/${id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/→\s*404/.test(msg)) return null;
    throw e;
  }
}

/**
 * Probe for an existing row by Guid (recreate no-op check). Returns the row, or null when no
 * row matches. Query FAILURES propagate — an unverifiable state is an error, not a "safe to
 * recreate" signal (recreating on top of an existing Guid would be the silent failure mode).
 */
async function tryFindByGuid(client: RockClient, table: string, guid: string): Promise<unknown | null> {
  const rows = await client.executeSql<Array<Record<string, unknown>>>(
    `SELECT TOP 1 * FROM [${table}] WHERE Guid = '${guid.replace(/'/g, "''")}'`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export async function rockRestore(client: RockClient, params: RockRestoreParams): Promise<unknown> {
  // ---- LIST mode ----
  if (!params.audit_id) {
    return listRecent(params.recent ?? 15);
  }

  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const ts = nowIso();
  const allRecords = await readLedgerRecords();
  const effective = findLedgerRecord(allRecords, params.audit_id);
  if (!effective) {
    throw new Error(`rock_restore: no ledger record found for audit_id "${params.audit_id}".`);
  }

  const plan = await classifyRestore(effective);

  // case a / h / g / generic refuse — no restore path exists. Never touches the ledger
  // (a refusal is not itself a write attempt worth recording).
  if (plan.kind === 'refuse') {
    return { phase: 'refused', restore_of: { auditId: effective.auditId, ts: effective.ts, tool: effective.tool, verb: effective.verb, target: effective.target }, reason: plan.reason, operator };
  }
  if (plan.kind === 'sql-refuse') {
    return {
      phase: 'refused',
      restore_of: { auditId: effective.auditId, ts: effective.ts, tool: effective.tool, verb: effective.verb, target: effective.target },
      reason:
        'SQL-mode edit/delete restore is not supported in v1 (documented scope cut). The snapshot is included ' +
        'below for a manual restore via rock_edit (mode:"sql") or rock_create (mode:"sql").',
      snapshotRef: plan.snapshotRef,
      snapshot: plan.snapshot,
      operator,
    };
  }

  // ---- Build the underlying WriteOp for this plan (drives the token + the actual write) ----
  let op: WriteOp;
  let target: ImpactTarget;
  let plannedPayload: unknown; // the exact body/sql this restore will apply — goes in the token AND the executed ledger record
  let plannedActionSummary: string;

  if (plan.kind === 'undo-create' && plan.mode === 'rest') {
    op = { verb: 'delete', mode: 'rest', controller: plan.controller, id: plan.id, body: { hard: true, restoreOf: params.audit_id, force: !!params.force } };
    target = { entityType: plan.entityType, id: plan.id };
    plannedPayload = { action: 'deleted', hard: true };
    plannedActionSummary = `Hard DELETE ${plan.controller}/${plan.id}`;
  } else if (plan.kind === 'undo-create' && plan.mode === 'sql') {
    const sql = `DELETE FROM [${plan.table}] WHERE Id = ${Number(plan.id)}`;
    // Safety net: classifyRestore already validated this exact statement (NaN + validateWrite);
    // re-check here so the write-SQL gate provably sits between us and executeSqlCommand
    // even if the classification logic drifts.
    const guard = validateWrite(sql, 'delete');
    if (!guard.valid) throw new Error(`SQL write rejected: ${guard.error}`);
    op = { verb: 'delete', mode: 'sql', sql, body: { restoreOf: params.audit_id, force: !!params.force } };
    target = { entityType: normalizeEntityType(plan.table), table: plan.table };
    plannedPayload = sql;
    plannedActionSummary = sql;
  } else if (plan.kind === 'patch-back') {
    op = { verb: 'edit', mode: 'rest', controller: plan.controller, id: plan.id, body: { ...plan.body, restoreOf: params.audit_id, force: !!params.force } };
    target = { entityType: plan.entityType, id: plan.id };
    plannedPayload = plan.body;
    plannedActionSummary = `PATCH ${plan.controller}/${plan.id} with ${truncateJson(plan.body)}`;
  } else if (plan.kind === 'reactivate') {
    const body = { IsActive: true };
    op = { verb: 'edit', mode: 'rest', controller: plan.controller, id: plan.id, body: { ...body, restoreOf: params.audit_id, force: !!params.force } };
    target = { entityType: plan.entityType, id: plan.id };
    plannedPayload = body;
    plannedActionSummary = `PATCH ${plan.controller}/${plan.id} with {"IsActive":true}`;
  } else {
    // recreate
    op = { verb: 'create', mode: 'rest', controller: plan.controller, body: { ...plan.body, __restoreOf: params.audit_id, __force: !!params.force } };
    target = { entityType: plan.entityType, guid: plan.guid };
    plannedPayload = plan.body;
    plannedActionSummary = `POST cleaned snapshot to ${plan.controller}`;
  }
  const token = deriveToken(op);

  // ---- Phase 2: execute ----
  if (params.confirmation_token) {
    if (!validateToken(op, params.confirmation_token)) {
      throw new Error(
        'Confirmation token mismatch — arguments changed since the preview (including force), or the preview ' +
          'was skipped. Re-call rock_restore with audit_id (and the SAME force value) WITHOUT a token to get a fresh preview.'
      );
    }

    // Staleness is RE-CHECKED at execute time: a write can land on this target in the gap
    // between the preview and the confirm, and silently overwriting it would defeat the
    // point of the gate. force:true is baked into the validated token and already
    // authorizes overwriting later changes, so this only gates the force-less path.
    if (!params.force) {
      const conflictsSincePreview = laterWritesToTarget(allRecords, effective.target, effective.ts, effective.auditId);
      if (conflictsSincePreview.length > 0) {
        const blockedAuditId = shortHash(token);
        await appendAudit({
          auditId: blockedAuditId, ts, phase: 'preview', operator, sessionTag, tool: 'rock_restore', verb: op.verb, mode: op.mode,
          target: { entityType: target.entityType, id: target.id, table: target.table },
          payload: { label: params.label, restoreOf: params.audit_id, plannedAction: plannedActionSummary, blockedByStaleness: true, atExecute: true },
          result: { success: true },
        });
        return {
          phase: 'blocked',
          reason: 'A later write touched this same target AFTER the preview was issued — executing now could silently overwrite it.',
          restore_of: { auditId: effective.auditId, ts: effective.ts, tool: effective.tool, verb: effective.verb, target: effective.target },
          later_writes: conflictsSincePreview,
          planned_action: plannedActionSummary,
          next_step:
            'Re-call rock_restore with this audit_id and NO token for a fresh preview; to proceed anyway, add ' +
            'force:true to that fresh preview and confirm with ITS token.',
          operator,
        };
      }
    }

    const auditId = shortHash(token);
    const restoreLabel = params.label ?? `restore of ${params.audit_id}`;

    if (plan.kind === 'undo-create' && plan.mode === 'rest') {
      const currentBefore = await tryGetCurrent(client, plan.controller, plan.id);
      const snapRef = await writeSnapshotFile(`${auditId}-before`, currentBefore);
      await client.v1Delete(`${plan.controller}/${plan.id}`);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_restore', verb: 'delete', mode: 'rest',
        target: { entityType: plan.entityType, id: plan.id }, snapshotRef: snapRef,
        payload: { label: restoreLabel, restoreOf: params.audit_id, action: 'deleted', hard: true },
        confirmationToken: params.confirmation_token, result: { success: true },
      });
      return {
        phase: 'executed', success: true, verb: 'delete', mode: 'rest', restore_of: params.audit_id,
        controller: plan.controller, id: plan.id, action: 'deleted',
        before_snapshot_ref: snapRef, auditId, auditLogged, operator,
      };
    }

    if (plan.kind === 'undo-create' && plan.mode === 'sql') {
      const sql = plannedPayload as string;
      // Current-row snapshot before the DELETE. An empty result means the row is already
      // gone (snapshot []); a query FAILURE propagates — never treat "couldn't check" as
      // "nothing there" on a destructive path.
      const currentBefore = await client.executeSql<unknown>(`SELECT * FROM [${plan.table}] WHERE Id = ${Number(plan.id)}`);
      const snapRef = await writeSnapshotFile(`${auditId}-before`, currentBefore);
      const rowsAffected = await client.executeSqlCommand(sql);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_restore', verb: 'delete', mode: 'sql',
        target: { entityType: normalizeEntityType(plan.table), table: plan.table }, snapshotRef: snapRef,
        payload: { label: restoreLabel, restoreOf: params.audit_id, sql }, confirmationToken: params.confirmation_token,
        result: { success: true, rowsAffected },
      });
      return {
        phase: 'executed', success: true, verb: 'delete', mode: 'sql', restore_of: params.audit_id,
        table: plan.table, rowsAffected, before_snapshot_ref: snapRef, auditId, auditLogged, operator,
      };
    }

    if (plan.kind === 'patch-back' || plan.kind === 'reactivate') {
      const controller = plan.controller;
      const id = plan.id;
      const body = plannedPayload as Record<string, unknown>;
      const currentBefore = await tryGetCurrent(client, controller, id);
      const snapRef = await writeSnapshotFile(`${auditId}-before`, currentBefore);
      await client.v1Patch(`${controller}/${id}`, body);
      // After-readback is display-only and the PATCH has already succeeded — a failed
      // readback must not fail the call (mirrors rock_edit's `.catch(() => undefined)`).
      const after = await client.v1Get<unknown>(`${controller}/${id}`).catch(() => undefined);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_restore', verb: 'edit', mode: 'rest',
        target: { entityType: plan.entityType, id }, snapshotRef: snapRef,
        payload: { label: restoreLabel, restoreOf: params.audit_id, body }, confirmationToken: params.confirmation_token,
        result: { success: true },
      });
      const hint = cacheHint(plan.entityType);
      return {
        phase: 'executed', success: true, verb: 'edit', mode: 'rest', restore_of: params.audit_id,
        controller, id, body, before_snapshot_ref: snapRef, before: currentBefore, after,
        cache_hint: hint, auditId, auditLogged, operator,
      };
    }

    // recreate
    const body = plannedPayload as Record<string, unknown>;
    const res = await client.v1Post<unknown>(plan.controller, body);
    const newId =
      typeof res === 'number'
        ? res
        : res && typeof res === 'object' && (typeof (res as Record<string, unknown>).Id === 'number' || typeof (res as Record<string, unknown>).Id === 'string')
          ? ((res as Record<string, unknown>).Id as string | number)
          : null;
    if (newId == null) {
      throw new Error(
        `rock_restore: recreate POST to ${plan.controller} returned no usable Id (${JSON.stringify(res).slice(0, 200)}) — ` +
          'verify in Rock before retrying; the row may have been created without a returned Id.'
      );
    }
    // Recreates are logged like a create (result.newId set) so an undo-of-this-restore
    // is itself handled by the generic undo-create path (case b).
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_restore', verb: 'create', mode: 'rest',
      target: { entityType: plan.entityType, id: newId }, payload: { label: restoreLabel, restoreOf: params.audit_id, body },
      confirmationToken: params.confirmation_token, result: { success: true, newId },
    });
    const hint = cacheHint(plan.entityType);
    return {
      phase: 'executed', success: true, verb: 'create', mode: 'rest', restore_of: params.audit_id,
      controller: plan.controller, newId, body, droppedNavFields: plan.droppedNav.length ? plan.droppedNav : undefined,
      cache_hint: hint, auditId, auditLogged, operator,
      warning: 'This row has a NEW numeric Id. Anything elsewhere in Rock that referenced the old Id by number (not Guid) will NOT be relinked.',
    };
  }

  // ---- Phase 1: preview ----
  const laterWrites = laterWritesToTarget(allRecords, effective.target, effective.ts, effective.auditId);
  const hasStaleness = laterWrites.length > 0;
  if (hasStaleness && !params.force) {
    const auditId = shortHash(token);
    // Log the preview even though we're withholding the token, so the "someone looked at
    // restoring this" moment is on the record.
    await appendAudit({
      auditId, ts, phase: 'preview', operator, sessionTag, tool: 'rock_restore', verb: op.verb, mode: op.mode,
      target: { entityType: target.entityType, id: target.id, table: target.table },
      payload: { label: params.label, restoreOf: params.audit_id, plannedAction: plannedActionSummary, blockedByStaleness: true },
      result: { success: true },
    });
    return {
      phase: 'blocked',
      reason: 'Later write(s) touched this same target after the original record — restoring now could overwrite that change.',
      restore_of: { auditId: effective.auditId, ts: effective.ts, tool: effective.tool, verb: effective.verb, target: effective.target },
      later_writes: laterWrites,
      planned_action: plannedActionSummary,
      next_step:
        'If you want to proceed anyway (acknowledging you may overwrite the later change), re-call rock_restore ' +
        'with the SAME audit_id plus force:true to get a token for this exact operation.',
      operator,
    };
  }

  // ---- No-op detection ----
  let noop = false;
  let currentState: unknown;
  if (plan.kind === 'patch-back' || plan.kind === 'reactivate') {
    currentState = await tryGetCurrent(client, plan.controller, plan.id);
    if (currentState && typeof currentState === 'object') {
      noop = shallowEqual(currentState as Record<string, unknown>, plannedPayload as Record<string, unknown>);
    }
  } else if (plan.kind === 'undo-create' && plan.mode === 'rest') {
    currentState = await tryGetCurrent(client, plan.controller, plan.id);
    noop = currentState === null; // already 404s — nothing to delete
  } else if (plan.kind === 'undo-create' && plan.mode === 'sql') {
    // Query failures propagate (an unverifiable state is an error, not a no-op) — only a
    // genuinely empty result set means the row is already gone.
    currentState = await client.executeSql<unknown>(`SELECT * FROM [${plan.table}] WHERE Id = ${Number(plan.id)}`);
    const rows = Array.isArray(currentState) ? currentState : currentState ? [currentState] : [];
    noop = rows.length === 0;
  } else {
    // recreate: probe by Guid
    if (plan.guid) {
      currentState = await tryFindByGuid(client, tableGuess(plan.entityType), plan.guid);
      noop = currentState !== null;
    } else {
      currentState = null;
    }
  }

  if (noop) {
    const auditId = shortHash(token);
    await appendAudit({
      auditId, ts, phase: 'preview', operator, sessionTag, tool: 'rock_restore', verb: op.verb, mode: op.mode,
      target: { entityType: target.entityType, id: target.id, table: target.table },
      payload: { label: params.label, restoreOf: params.audit_id, plannedAction: plannedActionSummary, noop: true },
      result: { success: true },
    });
    return {
      phase: 'noop',
      restore_of: { auditId: effective.auditId, ts: effective.ts, tool: effective.tool, verb: effective.verb, target: effective.target },
      reason: 'Current state already matches the restore target (or the row is already gone/already exists) — nothing to do.',
      current_state: currentState,
      operator,
    };
  }

  // ---- Impact analysis on destructive paths (case b + f: undo-create deletes) ----
  let impact: unknown;
  if (plan.kind === 'undo-create') {
    impact = await runImpact(client, target);
  }

  // ---- Before-snapshot being restored TO (the ORIGINAL before-state) ----
  const originalBefore = await loadSnapshot(effective.snapshotRef);

  const auditId = shortHash(token);
  await appendAudit({
    auditId, ts, phase: 'preview', operator, sessionTag, tool: 'rock_restore', verb: op.verb, mode: op.mode,
    target: { entityType: target.entityType, id: target.id, table: target.table },
    impactSummary: impact ? (impact as { summary?: string }).summary : undefined,
    payload: { label: params.label, restoreOf: params.audit_id, plannedAction: plannedActionSummary },
    confirmationToken: token, result: { success: true },
  });

  const warnings: string[] = [];
  if (plan.kind === 'patch-back') warnings.push(...plan.warnings);
  if (plan.kind === 'recreate') {
    warnings.push('Recreated row gets a NEW numeric Id (only Guid is preserved) — anything referencing the OLD Id by number will NOT be relinked.');
    if (plan.droppedNav.length) warnings.push(`Dropped navigation/nested properties not restorable via POST: ${plan.droppedNav.join(', ')}.`);
  }
  const hint = cacheHint(target.entityType);
  if (hint) warnings.push(hint);

  return {
    phase: 'preview',
    verb: op.verb,
    restore_of: { auditId: effective.auditId, ts: effective.ts, tool: effective.tool, verb: effective.verb, mode: effective.mode, target: effective.target, description: describeTarget(effective) },
    planned_action: plannedActionSummary,
    intended_change: op.mode === 'rest' ? { mode: 'rest', controller: op.controller, id: op.id, body: plannedPayload } : { mode: 'sql', sql: plannedPayload },
    current_state: currentState,
    before_snapshot: originalBefore.data ?? originalBefore.reason,
    later_writes: laterWrites, // empty unless force:true bypassed the staleness block above
    warnings: warnings.length ? warnings : undefined,
    impact,
    confirmation_token: token,
    next_step:
      'STOP. Show the user the planned action, current state, before-snapshot, and any warnings/impact above. ' +
      'Only after they approve, re-call rock_restore with the SAME arguments (including force, if set) plus this confirmation_token to execute.',
    operator,
  };
}

/**
 * Best-effort table-name guess for a recreate Guid probe (SELECT ... WHERE Guid = ...).
 * Rock's SQL table names match the singular entity type for every case in our irregular
 * map except the ones with their own SQL identity (e.g. [Group] is bracket-quoted at the
 * call site, not here). This mirrors tableFromWrite's role in rock-write.ts: a light,
 * best-effort mapping — good enough for a no-op probe, not load-bearing for the write itself.
 *
 * Defensive normalization (same reasoning as controllerFromEntityType above): this is fed a
 * ledgered entityType, which for historical rock_create REST records may still be plural
 * (e.g. "Blocks") — normalizeEntityType() maps that back to the singular SQL table name
 * ("Block") instead of probing a nonexistent plural table. No-op for already-singular input.
 */
function tableGuess(entityType: string): string {
  return normalizeEntityType(entityType);
}
