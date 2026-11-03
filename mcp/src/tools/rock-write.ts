/**
 * Guarded write tools for building in Rock — rock_create / rock_edit / rock_delete.
 *
 * These are the controlled, audited write surface that lets the team build pages, blocks,
 * attributes, and workflows directly through the MCP. They are split by VERB (not transport)
 * so the team's approval line maps onto Claude Code per-tool permissions:
 *
 *   - rock_create  → POST (REST) or INSERT (SQL). One-shot. "create = light."
 *   - rock_edit    → PATCH (REST) or UPDATE (SQL). Two-phase handshake. "edit = stop."
 *   - rock_delete  → DELETE (REST) or DELETE (SQL). Two-phase handshake. Prefers deactivate.
 *
 * Transport is a `mode` param ("rest" | "sql"); write-SQL is reachable ONLY through these
 * gated tools and is validated first (sql-write-validator.ts). Default REST path is v1 — the
 * documented working write path (v2 enforces a per-entity edit check that 401s even for admins).
 *
 * Edits/deletes use a two-phase handshake: the first call (no confirmation_token) captures a
 * before-snapshot + runs impact analysis and returns a deterministic confirmation_token WITHOUT
 * writing. After the user approves, the SAME call plus the token executes. See safety/confirm.ts.
 */

import { createHash } from 'node:crypto';
import { RockClient } from '../rock-client.js';
import { validateWrite } from '../sql-write-validator.js';
import {
  resolveGitIdentity,
  appendAudit,
  writeSnapshotFile,
  recordCreated,
  deriveToken,
  validateToken,
  captureRestSnapshot,
  captureSqlSnapshot,
  runImpact,
  normalizeEntityType,
  type WriteOp,
  type ImpactTarget,
} from '../safety/index.js';

// ---------------------------------------------------------------- helpers

function nowIso(): string {
  return new Date().toISOString();
}
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
function newIdFrom(res: unknown): string | number | null {
  if (typeof res === 'number') return res;
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    const v = o.Id ?? o.id ?? null;
    return (typeof v === 'number' || typeof v === 'string') ? v : null;
  }
  const n = Number(res);
  return Number.isFinite(n) ? n : null;
}
function tableFromWrite(sql: string): string | undefined {
  const s = sql.replace(/\s+/g, ' ').trim();
  return (
    s.match(/^INSERT\s+INTO\s+\[?(\w+)\]?/i)?.[1] ??
    s.match(/^UPDATE\s+\[?(\w+)\]?/i)?.[1] ??
    s.match(/^DELETE\s+FROM\s+\[?(\w+)\]?/i)?.[1] ??
    s.match(/^DELETE\s+\[?(\w+)\]?/i)?.[1]
  );
}

// ================================================================ rock_create

export interface RockCreateParams {
  mode: 'rest' | 'sql';
  controller?: string;
  body?: Record<string, unknown>;
  sql?: string;
  verifyByGuid?: string;
  cacheFlushWorkflowTypeId?: number;
  manifestSection?: string;
  manifestKey?: string;
  label?: string;
  session_tag?: string;
}

export const rockCreateSchema = {
  name: 'rock_create',
  description:
    'CREATE a brand-new object in Rock (page, block, attribute, workflow activity/action, group, ' +
    'category, defined value, auth, etc.). "create = light": it executes immediately and is logged ' +
    'to the audit ledger (logs/changes.jsonl) + manifest. Prefer building with NEW objects. ' +
    'mode:"rest" POSTs to a v1 controller (e.g. controller:"Pages", body:{...} in PascalCase). ' +
    'mode:"sql" runs a single INSERT — use only for tables REST can\'t handle (notably ' +
    'WorkflowActionType, whose POST hangs); pass verifyByGuid to confirm + return the new Id, and ' +
    'cacheFlushWorkflowTypeId to rebuild the workflow cache after inserting action rows. ' +
    'To EDIT or DELETE something that already exists, use rock_edit / rock_delete instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['rest', 'sql'], description: '"rest" (POST) or "sql" (INSERT)' },
      controller: { type: 'string', description: 'REST controller for mode:"rest", e.g. "Pages", "Blocks", "Attributes"' },
      body: { type: 'object', description: 'Entity body (PascalCase Rock properties) for mode:"rest"' },
      sql: { type: 'string', description: 'A single INSERT statement for mode:"sql"' },
      verifyByGuid: { type: 'string', description: 'mode:"sql": the literal Guid you inlined in the INSERT (never NEWID() — it must appear verbatim in the SQL); verifies the row and returns its Id' },
      cacheFlushWorkflowTypeId: { type: 'number', description: 'mode:"sql": PATCH this WorkflowType\'s ModifiedDateTime to rebuild Rock\'s workflow cache after inserting action rows' },
      manifestSection: { type: 'string', description: 'Optional: record the new Id under this manifest section (for clean revert)' },
      manifestKey: { type: 'string', description: 'Optional: manifest key for the new Id' },
      label: { type: 'string', description: 'Optional human label recorded in the audit ledger' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id (or another caller-chosen identifier), recorded on ' +
          'the audit ledger entry alongside the operator\'s git identity. The MCP server has no ' +
          'reliable way to see this itself (env vars at spawn and the MCP handshake do not carry ' +
          'a session id) — pass it explicitly so "did my session touch prod?" is answerable later.',
      },
    },
    required: ['mode'],
  },
};

export async function rockCreate(client: RockClient, params: RockCreateParams): Promise<unknown> {
  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const ts = nowIso();

  if (params.mode === 'rest') {
    if (!params.controller || !params.body) {
      throw new Error('rock_create (mode:"rest") requires controller and body.');
    }
    const res = await client.v1Post<unknown>(params.controller, params.body);
    const newId = newIdFrom(res);
    if (params.manifestSection && params.manifestKey && newId != null) {
      recordCreated(params.manifestSection, params.manifestKey, newId);
    }
    const auditId = shortHash(`create|rest|${params.controller}|${JSON.stringify(params.body)}|${ts}`);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'create', operator, sessionTag, tool: 'rock_create', verb: 'create', mode: 'rest',
      target: { entityType: normalizeEntityType(params.controller) }, payload: { label: params.label, body: params.body },
      result: { success: true, newId: newId ?? undefined },
    });
    return {
      success: true, verb: 'create', mode: 'rest', controller: params.controller, newId,
      manifest: params.manifestSection && params.manifestKey ? { section: params.manifestSection, key: params.manifestKey, id: newId } : undefined,
      auditId, auditLogged, operator,
    };
  }

  // mode: 'sql'
  if (!params.sql) throw new Error('rock_create (mode:"sql") requires sql (a single INSERT).');
  const v = validateWrite(params.sql, 'create');
  if (!v.valid) throw new Error(`SQL write rejected: ${v.error}`);

  // verifyByGuid must be checkable BEFORE the INSERT runs: a bad value here makes the
  // post-insert verify fail in a way that's indistinguishable from a failed write — and the
  // write HAS committed by then, so a blind retry hits a duplicate-key error.
  if (params.verifyByGuid) {
    const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!guidRe.test(params.verifyByGuid)) {
      throw new Error(
        `rock_create: verifyByGuid ("${params.verifyByGuid}") is not a GUID. Nothing was written. ` +
          'Generate a concrete GUID yourself, put it in the INSERT\'s Guid column, and pass the same value here.'
      );
    }
    if (!params.sql.toLowerCase().includes(params.verifyByGuid.toLowerCase())) {
      throw new Error(
        'rock_create: verifyByGuid does not appear as a literal in the SQL. Nothing was written. ' +
          'Never use NEWID() with verifyByGuid — the verify SELECT can only find a Guid you chose yourself. ' +
          'Generate a GUID, inline it in the INSERT, and pass the identical value as verifyByGuid.'
      );
    }
  }

  const rowsAffected = await client.executeSqlCommand(params.sql);

  let newId: string | number | null = null;
  const table = tableFromWrite(params.sql);
  if (params.verifyByGuid && table) {
    const g = params.verifyByGuid.replace(/'/g, "''");
    let rows: unknown;
    try {
      rows = await client.executeSql<Array<Record<string, unknown>>>(
        `SELECT TOP 1 Id FROM ${table} WHERE Guid = '${g}'`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `rock_create: the INSERT executed (rowsAffected=${rowsAffected}) but the verify SELECT errored: ${msg}. ` +
          'The row may already exist — check with execute_sql before retrying, or the retry will hit a duplicate-key error.'
      );
    }
    if (Array.isArray(rows) && rows[0]) {
      const idv = (rows[0] as Record<string, unknown>).Id;
      newId = typeof idv === 'number' || typeof idv === 'string' ? idv : null;
    }
    if (newId == null) {
      throw new Error(
        `rock_create: INSERT verify failed — no ${table} row with Guid ${params.verifyByGuid}. ` +
          `NOTE: the INSERT itself executed (rowsAffected=${rowsAffected}) and may have committed with a different Guid — ` +
          'check with execute_sql before retrying; a blind re-run can create a duplicate or hit a duplicate-key error.'
      );
    }
  }

  let cacheFlushed = false;
  if (params.cacheFlushWorkflowTypeId != null) {
    await client.v1Patch(`WorkflowTypes/${params.cacheFlushWorkflowTypeId}`, { ModifiedDateTime: nowIso() });
    cacheFlushed = true;
  }

  if (params.manifestSection && params.manifestKey && newId != null) {
    recordCreated(params.manifestSection, params.manifestKey, newId);
  }
  const auditId = shortHash(`create|sql|${params.sql}|${ts}`);
  const auditLogged = await appendAudit({
    auditId, ts, phase: 'create', operator, sessionTag, tool: 'rock_create', verb: 'create', mode: 'sql',
    target: { entityType: table ? normalizeEntityType(table) : 'unknown', table },
    payload: { label: params.label, sql: params.sql }, result: { success: true, newId: newId ?? undefined, rowsAffected },
  });
  return { success: true, verb: 'create', mode: 'sql', table, newId, rowsAffected, cacheFlushed, auditId, auditLogged, operator };
}

// ================================================================ rock_edit

export interface RockEditParams {
  mode: 'rest' | 'sql';
  controller?: string;
  id?: string | number;
  body?: Record<string, unknown>;
  sql?: string;
  snapshotQuery?: string;
  confirmation_token?: string;
  label?: string;
  session_tag?: string;
}

export const rockEditSchema = {
  name: 'rock_edit',
  description:
    'EDIT an EXISTING Rock object — a HARD-STOP, two-phase action ("edit = stop"). ' +
    'Call WITHOUT confirmation_token first: this captures a before-snapshot, runs impact analysis ' +
    '(what reports/pages/blocks reference the target), and returns a confirmation_token WITHOUT writing. ' +
    'STOP and show the user the impact + snapshot; only after they approve, re-call with the SAME ' +
    'arguments plus the confirmation_token to execute. mode:"rest" PATCHes controller/{id} with a ' +
    'partial body; mode:"sql" runs a single UPDATE and REQUIRES snapshotQuery (a SELECT capturing the ' +
    'rows it will change) so the change is reversible.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['rest', 'sql'], description: '"rest" (PATCH) or "sql" (UPDATE)' },
      controller: { type: 'string', description: 'REST controller for mode:"rest", e.g. "Blocks"' },
      id: { type: ['string', 'number'], description: 'Target id for mode:"rest"' },
      body: { type: 'object', description: 'Partial update body (PascalCase) for mode:"rest"' },
      sql: { type: 'string', description: 'A single UPDATE statement for mode:"sql"' },
      snapshotQuery: { type: 'string', description: 'mode:"sql": a SELECT capturing the rows the UPDATE will change (required, for reversibility)' },
      confirmation_token: { type: 'string', description: 'Omit on the first (preview) call; pass the returned token on the second (execute) call' },
      label: { type: 'string', description: 'Optional human label recorded in the audit ledger' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on the audit ledger entry alongside the ' +
          'operator\'s git identity, so "did my session touch prod?" is answerable later. Pass ' +
          'the same value on both the preview and execute calls if you want it on the executed record.',
      },
    },
    required: ['mode'],
  },
};

export async function rockEdit(client: RockClient, params: RockEditParams): Promise<unknown> {
  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const ts = nowIso();

  const op: WriteOp =
    params.mode === 'rest'
      ? { verb: 'edit', mode: 'rest', controller: params.controller, id: params.id, body: params.body }
      : { verb: 'edit', mode: 'sql', sql: params.sql };
  const token = deriveToken(op);

  // ---- Phase 2: execute (token present) ----
  if (params.confirmation_token) {
    if (!validateToken(op, params.confirmation_token)) {
      throw new Error(
        'Confirmation token mismatch — arguments changed since the preview, or the preview was skipped. ' +
          'Re-call rock_edit WITHOUT a token to get a fresh preview.'
      );
    }
    if (params.mode === 'rest') {
      if (!params.controller || params.id === undefined || !params.body) {
        throw new Error('rock_edit (mode:"rest") requires controller, id, and body.');
      }
      const snap = await captureRestSnapshot(client, params.controller, params.id, ts);
      const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
      await client.v1Patch(`${params.controller}/${params.id}`, params.body);
      const after = await client.v1Get<unknown>(`${params.controller}/${params.id}`).catch(() => undefined);
      const auditId = shortHash(token);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_edit', verb: 'edit', mode: 'rest',
        target: { entityType: normalizeEntityType(params.controller), id: params.id }, snapshotRef: snapRef,
        payload: { label: params.label, body: params.body }, confirmationToken: params.confirmation_token,
        result: { success: true },
      });
      return { phase: 'executed', success: true, verb: 'edit', mode: 'rest', controller: params.controller, id: params.id, before_snapshot_ref: snapRef, before: snap.data, after, auditId, auditLogged, operator };
    }
    // sql edit
    if (!params.sql) throw new Error('rock_edit (mode:"sql") requires sql.');
    const v = validateWrite(params.sql, 'edit');
    if (!v.valid) throw new Error(`SQL write rejected: ${v.error}`);
    if (!params.snapshotQuery) throw new Error('rock_edit (mode:"sql") requires snapshotQuery for reversibility.');
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
    const rowsAffected = await client.executeSqlCommand(params.sql);
    const table = tableFromWrite(params.sql);
    const auditId = shortHash(token);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_edit', verb: 'edit', mode: 'sql',
      target: { entityType: table ? normalizeEntityType(table) : 'unknown', table }, snapshotRef: snapRef,
      payload: { label: params.label, sql: params.sql }, confirmationToken: params.confirmation_token,
      result: { success: true, rowsAffected },
    });
    return { phase: 'executed', success: true, verb: 'edit', mode: 'sql', table, rowsAffected, before_snapshot_ref: snapRef, before: snap.data, auditId, auditLogged, operator };
  }

  // ---- Phase 1: preview (no token) ----
  let snapshotData: unknown;
  let target: ImpactTarget;
  if (params.mode === 'rest') {
    if (!params.controller || params.id === undefined || !params.body) {
      throw new Error('rock_edit (mode:"rest") requires controller, id, and body.');
    }
    const snap = await captureRestSnapshot(client, params.controller, params.id, ts);
    snapshotData = snap.data;
    const row = snap.data as Record<string, unknown>;
    target = {
      entityType: normalizeEntityType(params.controller),
      id: params.id,
      guid: typeof row?.Guid === 'string' ? row.Guid : undefined,
      key: typeof row?.Key === 'string' ? row.Key : undefined,
    };
  } else {
    if (!params.sql) throw new Error('rock_edit (mode:"sql") requires sql.');
    const v = validateWrite(params.sql, 'edit');
    if (!v.valid) throw new Error(`SQL write rejected: ${v.error}`);
    if (!params.snapshotQuery) throw new Error('rock_edit (mode:"sql") requires snapshotQuery (a SELECT of the rows the UPDATE will change).');
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    snapshotData = snap.data;
    const tbl = tableFromWrite(params.sql);
    target = { entityType: tbl ? normalizeEntityType(tbl) : 'unknown', table: tbl };
  }

  const impact = await runImpact(client, target);
  const auditId = shortHash(token);
  await appendAudit({
    auditId, ts, phase: 'preview', operator, sessionTag, tool: 'rock_edit', verb: 'edit', mode: params.mode,
    target: { entityType: target.entityType, id: target.id, table: target.table }, impactSummary: impact.summary,
    payload: params.mode === 'rest' ? params.body : params.sql, confirmationToken: token, result: { success: true },
  });
  return {
    phase: 'preview',
    verb: 'edit',
    confirmation_token: token,
    intended_change:
      params.mode === 'rest'
        ? { mode: 'rest', controller: params.controller, id: params.id, body: params.body }
        : { mode: 'sql', sql: params.sql },
    before_snapshot: snapshotData,
    impact,
    next_step:
      'STOP. Show the user the impact analysis and before-snapshot above. Only after they approve, ' +
      're-call rock_edit with the SAME arguments plus this confirmation_token to execute.',
    operator,
  };
}

// ================================================================ rock_delete

export interface RockDeleteParams {
  mode: 'rest' | 'sql';
  controller?: string;
  id?: string | number;
  sql?: string;
  snapshotQuery?: string;
  hard?: boolean;
  confirmation_token?: string;
  label?: string;
  session_tag?: string;
}

export const rockDeleteSchema = {
  name: 'rock_delete',
  description:
    'DELETE an EXISTING Rock object — a HARD-STOP, two-phase action (same handshake as rock_edit). ' +
    'PREFERS deactivation: for mode:"rest", if the entity has an IsActive field and hard is not true, ' +
    'it sets IsActive=false (trivially reversible) instead of hard-deleting. Pass hard:true to force a ' +
    'real DELETE. Call WITHOUT confirmation_token first to get the impact analysis + before-snapshot + ' +
    'token; show the user, then re-call with the token to execute. mode:"sql" runs a single DELETE and ' +
    'REQUIRES snapshotQuery (a SELECT of the rows it will remove) so the row can be re-created on revert.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['rest', 'sql'], description: '"rest" (DELETE/deactivate) or "sql" (DELETE)' },
      controller: { type: 'string', description: 'REST controller for mode:"rest"' },
      id: { type: ['string', 'number'], description: 'Target id for mode:"rest"' },
      sql: { type: 'string', description: 'A single DELETE statement for mode:"sql"' },
      snapshotQuery: { type: 'string', description: 'mode:"sql": a SELECT capturing the rows the DELETE will remove (required)' },
      hard: { type: 'boolean', description: 'mode:"rest": force a real DELETE instead of deactivating (default false)' },
      confirmation_token: { type: 'string', description: 'Omit on the first (preview) call; pass the returned token on the second (execute) call' },
      label: { type: 'string', description: 'Optional human label recorded in the audit ledger' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on the audit ledger entry alongside the ' +
          'operator\'s git identity, so "did my session touch prod?" is answerable later. Pass ' +
          'the same value on both the preview and execute calls if you want it on the executed record.',
      },
    },
    required: ['mode'],
  },
};

export async function rockDelete(client: RockClient, params: RockDeleteParams): Promise<unknown> {
  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const ts = nowIso();

  const op: WriteOp =
    params.mode === 'rest'
      ? { verb: 'delete', mode: 'rest', controller: params.controller, id: params.id, body: { hard: !!params.hard } }
      : { verb: 'delete', mode: 'sql', sql: params.sql };
  const token = deriveToken(op);

  // ---- Phase 2: execute ----
  if (params.confirmation_token) {
    if (!validateToken(op, params.confirmation_token)) {
      throw new Error(
        'Confirmation token mismatch — arguments changed since the preview, or the preview was skipped. ' +
          'Re-call rock_delete WITHOUT a token to get a fresh preview.'
      );
    }
    if (params.mode === 'rest') {
      if (!params.controller || params.id === undefined) {
        throw new Error('rock_delete (mode:"rest") requires controller and id.');
      }
      const snap = await captureRestSnapshot(client, params.controller, params.id, ts);
      const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
      const row = snap.data as Record<string, unknown>;
      const canDeactivate = !params.hard && row && Object.prototype.hasOwnProperty.call(row, 'IsActive');
      let action: 'deactivated' | 'deleted';
      if (canDeactivate) {
        await client.v1Patch(`${params.controller}/${params.id}`, { IsActive: false });
        action = 'deactivated';
      } else {
        await client.v1Delete(`${params.controller}/${params.id}`);
        action = 'deleted';
      }
      const auditId = shortHash(token);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_delete', verb: 'delete', mode: 'rest',
        target: { entityType: normalizeEntityType(params.controller), id: params.id }, snapshotRef: snapRef,
        payload: { label: params.label, action, hard: !!params.hard }, confirmationToken: params.confirmation_token,
        result: { success: true },
      });
      return { phase: 'executed', success: true, verb: 'delete', mode: 'rest', action, controller: params.controller, id: params.id, before_snapshot_ref: snapRef, before: snap.data, auditId, auditLogged, operator };
    }
    // sql delete
    if (!params.sql) throw new Error('rock_delete (mode:"sql") requires sql.');
    const v = validateWrite(params.sql, 'delete');
    if (!v.valid) throw new Error(`SQL write rejected: ${v.error}`);
    if (!params.snapshotQuery) throw new Error('rock_delete (mode:"sql") requires snapshotQuery for reversibility.');
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
    const rowsAffected = await client.executeSqlCommand(params.sql);
    const table = tableFromWrite(params.sql);
    const auditId = shortHash(token);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_delete', verb: 'delete', mode: 'sql',
      target: { entityType: table ? normalizeEntityType(table) : 'unknown', table }, snapshotRef: snapRef,
      payload: { label: params.label, sql: params.sql }, confirmationToken: params.confirmation_token,
      result: { success: true, rowsAffected },
    });
    return { phase: 'executed', success: true, verb: 'delete', mode: 'sql', table, rowsAffected, before_snapshot_ref: snapRef, before: snap.data, auditId, auditLogged, operator };
  }

  // ---- Phase 1: preview ----
  let snapshotData: unknown;
  let target: ImpactTarget;
  let willDeactivate = false;
  if (params.mode === 'rest') {
    if (!params.controller || params.id === undefined) {
      throw new Error('rock_delete (mode:"rest") requires controller and id.');
    }
    const snap = await captureRestSnapshot(client, params.controller, params.id, ts);
    snapshotData = snap.data;
    const row = snap.data as Record<string, unknown>;
    willDeactivate = !params.hard && !!row && Object.prototype.hasOwnProperty.call(row, 'IsActive');
    target = {
      entityType: normalizeEntityType(params.controller),
      id: params.id,
      guid: typeof row?.Guid === 'string' ? row.Guid : undefined,
      key: typeof row?.Key === 'string' ? row.Key : undefined,
    };
  } else {
    if (!params.sql) throw new Error('rock_delete (mode:"sql") requires sql.');
    const v = validateWrite(params.sql, 'delete');
    if (!v.valid) throw new Error(`SQL write rejected: ${v.error}`);
    if (!params.snapshotQuery) throw new Error('rock_delete (mode:"sql") requires snapshotQuery (a SELECT of the rows the DELETE will remove).');
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    snapshotData = snap.data;
    const tbl = tableFromWrite(params.sql);
    target = { entityType: tbl ? normalizeEntityType(tbl) : 'unknown', table: tbl };
  }

  const impact = await runImpact(client, target);
  const auditId = shortHash(token);
  await appendAudit({
    auditId, ts, phase: 'preview', operator, sessionTag, tool: 'rock_delete', verb: 'delete', mode: params.mode,
    target: { entityType: target.entityType, id: target.id, table: target.table }, impactSummary: impact.summary,
    payload: { label: params.label, sql: params.sql }, confirmationToken: token, result: { success: true },
  });
  return {
    phase: 'preview',
    verb: 'delete',
    planned_action: params.mode === 'rest' ? (willDeactivate ? 'deactivate (IsActive=false)' : 'hard delete') : 'sql delete',
    confirmation_token: token,
    intended_change:
      params.mode === 'rest'
        ? { mode: 'rest', controller: params.controller, id: params.id, hard: !!params.hard }
        : { mode: 'sql', sql: params.sql },
    before_snapshot: snapshotData,
    impact,
    next_step:
      'STOP. Show the user the impact analysis and before-snapshot above. Only after they approve, ' +
      're-call rock_delete with the SAME arguments plus this confirmation_token to execute.',
    operator,
  };
}
