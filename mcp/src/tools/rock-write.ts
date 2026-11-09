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
  isDevTarget,
  WriteRefused,
  enforceBulkCap,
  readBack,
  UNCERTAIN_OUTCOME_NOTE,
  REASON_PARAM,
  ALLOW_BULK_PARAM,
  type WriteOp,
  type ImpactTarget,
  type AuditRecord,
} from '../safety/index.js';
import { preflightSqlWrite } from '../safety/sqlPreflight.js';
import { checkAuthWrite } from '../safety/authGuards.js';
import { fieldsMatch, v1GetOrNull } from './legacy-helpers.js';

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

/** Replace the inside of '...' literals with spaces so structure scans ignore values. */
function maskQuoted(sql: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inQuote) {
      if (c === "'") {
        if (sql[i + 1] === "'") { out += '  '; i++; continue; }
        inQuote = false;
        out += c;
      } else {
        out += ' ';
      }
      continue;
    }
    if (c === "'") inQuote = true;
    out += c;
  }
  return out;
}

/** Index of a keyword at paren depth 0 (masked text), or -1. */
function topLevelKeyword(masked: string, keyword: RegExp, from = 0): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth !== 0) continue;
    if (i > 0 && /[\w@#$\]]/.test(masked[i - 1])) continue;
    const m = masked.slice(i).match(keyword);
    if (m && m.index === 0) return i;
  }
  return -1;
}

/**
 * How many rows an INSERT will write, for the bulk cap. VALUES: the number of tuples.
 * INSERT … SELECT: a read-only COUNT(*) over the SELECT. null when it cannot be counted.
 */
export async function countInsertRows(client: RockClient, sql: string): Promise<number | null> {
  const text = sql.replace(/^\s*--.*$/gm, '').trim();
  const masked = maskQuoted(text);
  const open = masked.indexOf('(');
  if (open < 0) return null;
  // Skip the column list.
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const valuesAt = topLevelKeyword(masked, /^VALUES\b/i, close + 1);
  const selectAt = topLevelKeyword(masked, /^SELECT\b/i, close + 1);
  if (valuesAt >= 0 && (selectAt < 0 || valuesAt < selectAt)) {
    let n = 0;
    let d = 0;
    for (let i = valuesAt + 6; i < masked.length; i++) {
      if (masked[i] === '(') { if (d === 0) n++; d++; }
      else if (masked[i] === ')') d--;
    }
    return n;
  }
  if (selectAt >= 0) {
    try {
      const rows = await client.executeSql<Array<{ n: number }>>(
        `SELECT COUNT(*) AS n FROM (${text.slice(selectAt)}) AS bulk_count_check`
      );
      const n = Array.isArray(rows) && rows[0] ? Number(rows[0].n) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The SQL checks every mode:"sql" write passes before it runs: the shape/keyword check
 * (validateWrite), the preflight (columns, audit fields — may return an amended statement),
 * and the Auth-table guard. Any failure is a refusal. Returns the SQL to execute + warnings.
 */
async function sqlWriteChecks(
  client: RockClient,
  sql: string,
  mode: 'create' | 'edit' | 'delete',
  target: AuditRecord['target']
): Promise<{ sql: string; warnings: string[] }> {
  const v = validateWrite(sql, mode);
  if (!v.valid) throw new WriteRefused(`SQL write rejected: ${v.error}`, target);
  const pre = await preflightSqlWrite(sql, { client, target: isDevTarget() ? 'dev' : 'prod' });
  if (!pre.ok) {
    throw new WriteRefused(`SQL preflight refused this write: ${pre.errors.join(' | ')}. Nothing was written.`, target);
  }
  const execSql = pre.sql && pre.sql.trim() ? pre.sql : sql;
  const v2 = validateWrite(execSql, mode);
  if (!v2.valid) throw new WriteRefused(`SQL write rejected after preflight: ${v2.error}`, target);
  const auth = await checkAuthWrite(execSql, { client });
  if (!auth.ok) {
    throw new WriteRefused(`Auth-table guard refused this write: ${auth.errors.join(' | ')}. Nothing was written.`, target);
  }
  return { sql: execSql, warnings: [...pre.warnings, ...auth.warnings] };
}

/** Row count of a SQL snapshot capture (the rows an UPDATE/DELETE will touch). */
function snapshotRowCount(data: unknown): number {
  return Array.isArray(data) ? data.length : data == null ? 0 : 1;
}

/**
 * How many rows a single-table UPDATE/DELETE will change, counted from the statement's OWN
 * WHERE with a read-only `SELECT COUNT(*) FROM <table> WHERE …` (no WHERE = the whole table).
 * null when the statement can't be counted this way (joins, aliases, TOP, OUTPUT); the
 * execute-time row-count guard still applies then.
 */
export async function countStatementRows(client: RockClient, sql: string): Promise<number | null> {
  const text = sql.replace(/^\s*--.*$/gm, '').trim().replace(/;+\s*$/, '');
  const masked = maskQuoted(text);
  let targetText: string;
  let bodyStart: number;
  const up = masked.match(/^UPDATE\s+/i);
  if (up) {
    const setAt = topLevelKeyword(masked, /^SET\b/i, up[0].length);
    if (setAt < 0) return null;
    targetText = text.slice(up[0].length, setAt).trim();
    bodyStart = setAt;
  } else {
    const del = masked.match(/^DELETE\s+(FROM\s+)?/i);
    if (!del) return null;
    const w = topLevelKeyword(masked, /^WHERE\b/i, del[0].length);
    targetText = text.slice(del[0].length, w >= 0 ? w : text.length).trim();
    bodyStart = del[0].length;
  }
  if (!/^(\[?\w+\]?\.)?\[?\w+\]?$/.test(targetText)) return null;
  if (topLevelKeyword(masked, /^(FROM|OUTPUT|OPTION)\b/i, bodyStart) >= 0) return null;
  const whereAt = topLevelKeyword(masked, /^WHERE\b/i, bodyStart);
  const where = whereAt >= 0 ? ` ${text.slice(whereAt)}` : '';
  try {
    const rows = await client.executeSql<Array<{ n: number }>>(`SELECT COUNT(*) AS n FROM ${targetText}${where}`);
    const n = Array.isArray(rows) && rows[0] ? Number(rows[0].n) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Row checks for a SQL UPDATE/DELETE, run at preview AND execute: the statement's own WHERE
 * must match the same number of rows as snapshotQuery (otherwise the preview count and the
 * before-snapshot don't describe what will change), and that count must pass the bulk cap.
 */
async function sqlRowChecks(
  client: RockClient,
  sql: string,
  snapshotRows: number,
  what: string,
  target: AuditRecord['target']
): Promise<{ statementRows: number | null }> {
  const statementRows = await countStatementRows(client, sql);
  if (statementRows !== null && statementRows !== snapshotRows) {
    throw new WriteRefused(
      `Refused: the ${what}'s own WHERE matches ${statementRows} row(s) but snapshotQuery returned ${snapshotRows}. ` +
        'The snapshotQuery must select exactly the rows the statement changes, so the preview count and the ' +
        'before-snapshot are accurate. Nothing was written.',
      target
    );
  }
  enforceBulkCap(statementRows ?? snapshotRows, what, target);
  return { statementRows };
}

const ROW_GUARD_MARKER = 'ROCK_MCP_ROW_GUARD';

/**
 * Wrap a single UPDATE/DELETE in a transaction that rolls back and raises an error when the
 * statement changes more than maxRows rows (the snapshot count). This holds even when the
 * statement couldn't be counted up front or the data changed after the preview.
 */
export function guardRowCount(sql: string, maxRows: number): string {
  const stmt = sql.trim().replace(/;+\s*$/, '');
  return (
    'BEGIN TRY BEGIN TRAN; ' +
    `${stmt}; ` +
    'DECLARE @rock_mcp_rows INT = @@ROWCOUNT; ' +
    `IF @rock_mcp_rows > ${Math.max(0, Math.floor(maxRows))} BEGIN ` +
    'ROLLBACK TRAN; ' +
    `DECLARE @rock_mcp_msg NVARCHAR(400) = CONCAT('${ROW_GUARD_MARKER}: the statement changed ', @rock_mcp_rows, ' rows, more than the ${maxRows} in the snapshot; rolled back'); ` +
    'THROW 50000, @rock_mcp_msg, 1; END; ' +
    'COMMIT TRAN; END TRY ' +
    'BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK TRAN; THROW; END CATCH'
  );
}

/** Run an UPDATE/DELETE under guardRowCount. A guard rollback becomes a ledgered refusal. */
async function runGuardedSql(
  client: RockClient,
  sql: string,
  maxRows: number,
  what: string,
  target: AuditRecord['target']
): Promise<number> {
  try {
    return await client.executeSqlCommand(guardRowCount(sql, maxRows));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(ROW_GUARD_MARKER)) {
      throw new WriteRefused(
        `Rolled back: the ${what} changed more rows than the ${maxRows} captured by snapshotQuery, so nothing was kept. ` +
          `Rock said: ${msg.slice(0, 300)}. Fix the WHERE or the snapshotQuery and preview again.`,
        target
      );
    }
    throw e;
  }
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
  reason?: string;
  allowBulk?: boolean;
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
    'To EDIT or DELETE something that already exists, use rock_edit / rock_delete instead. ' +
    'mode:"sql" INSERTs pass the SQL preflight and Auth-table guard first, and one call may not write ' +
    'more than ROCK_MCP_BULK_WRITE_MAX rows (default 25) without allowBulk:true. The result says ' +
    'verified:true/false from a re-read of the new row.',
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
      reason: REASON_PARAM,
      allowBulk: ALLOW_BULK_PARAM,
    },
    required: ['mode', 'reason'],
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
    const controller = params.controller;
    const rb = await readBack(async () => {
      if (newId == null) return { verified: false, note: `${controller} POST returned no Id, so the new row could not be re-read. ${UNCERTAIN_OUTCOME_NOTE}` };
      const row = await client.v1Get<unknown>(`${controller}/${newId}`);
      return { verified: row != null };
    });
    if (params.manifestSection && params.manifestKey && newId != null) {
      recordCreated(params.manifestSection, params.manifestKey, newId);
    }
    const auditId = shortHash(`create|rest|${params.controller}|${JSON.stringify(params.body)}|${ts}`);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'create', operator, sessionTag, tool: 'rock_create', verb: 'create', mode: 'rest',
      target: { entityType: normalizeEntityType(params.controller) }, payload: { label: params.label, body: params.body },
      result: { success: true, newId: newId ?? undefined, verified: rb.verified },
    });
    return {
      success: true, verb: 'create', mode: 'rest', controller: params.controller, newId,
      manifest: params.manifestSection && params.manifestKey ? { section: params.manifestSection, key: params.manifestKey, id: newId } : undefined,
      verified: rb.verified, verification_note: rb.verification_note,
      auditId, auditLogged, operator,
    };
  }

  // mode: 'sql'
  if (!params.sql) throw new Error('rock_create (mode:"sql") requires sql (a single INSERT).');
  const createTable = tableFromWrite(params.sql);
  const createTarget = { entityType: createTable ? normalizeEntityType(createTable) : 'unknown', table: createTable };
  const v = validateWrite(params.sql, 'create');
  if (!v.valid) throw new WriteRefused(`SQL write rejected: ${v.error}`, createTarget);

  // verifyByGuid must be checkable BEFORE the INSERT runs: a bad value here makes the
  // post-insert verify fail in a way that's indistinguishable from a failed write — and the
  // write HAS committed by then, so a blind retry hits a duplicate-key error.
  if (params.verifyByGuid) {
    const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!guidRe.test(params.verifyByGuid)) {
      throw new WriteRefused(
        `rock_create: verifyByGuid ("${params.verifyByGuid}") is not a GUID. Nothing was written. ` +
          'Generate a concrete GUID yourself, put it in the INSERT\'s Guid column, and pass the same value here.',
        createTarget
      );
    }
    if (!params.sql.toLowerCase().includes(params.verifyByGuid.toLowerCase())) {
      throw new WriteRefused(
        'rock_create: verifyByGuid does not appear as a literal in the SQL. Nothing was written. ' +
          'Never use NEWID() with verifyByGuid — the verify SELECT can only find a Guid you chose yourself. ' +
          'Generate a GUID, inline it in the INSERT, and pass the identical value as verifyByGuid.',
        createTarget
      );
    }
  }

  // Bulk cap, then the SQL preflight + Auth guard (which may amend the statement).
  const plannedRows = await countInsertRows(client, params.sql);
  enforceBulkCap(plannedRows, 'rock_create INSERT', createTarget);
  const checked = await sqlWriteChecks(client, params.sql, 'create', createTarget);

  const rowsAffected = await client.executeSqlCommand(checked.sql);

  // Read-back. A failed verify does not throw any more: the INSERT has already run, so the
  // outcome is ledgered as unverified and reported, never retried.
  let newId: string | number | null = null;
  const table = createTable;
  let verified = false;
  let verificationNote: string | undefined;
  if (params.verifyByGuid && table) {
    const g = params.verifyByGuid.replace(/'/g, "''");
    try {
      const rows = await client.executeSql<Array<Record<string, unknown>>>(
        `SELECT TOP 1 Id FROM ${table} WHERE Guid = '${g}'`
      );
      if (Array.isArray(rows) && rows[0]) {
        const idv = (rows[0] as Record<string, unknown>).Id;
        newId = typeof idv === 'number' || typeof idv === 'string' ? idv : null;
      }
      verified = newId != null;
      if (!verified) {
        verificationNote =
          `INSERT verify failed — no ${table} row with Guid ${params.verifyByGuid}. The INSERT itself executed ` +
          `(rowsAffected=${rowsAffected}) and may have committed with a different Guid. ${UNCERTAIN_OUTCOME_NOTE}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      verificationNote =
        `The INSERT executed (rowsAffected=${rowsAffected}) but the verify SELECT errored: ${msg}. ${UNCERTAIN_OUTCOME_NOTE}`;
    }
  } else {
    verificationNote =
      'No verifyByGuid was given, so the new row was not re-read. Pass a literal Guid in the INSERT and as verifyByGuid to get a verified result.';
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
    payload: { label: params.label, sql: params.sql, executedSql: checked.sql !== params.sql ? checked.sql : undefined, plannedRows },
    result: { success: true, newId: newId ?? undefined, rowsAffected, verified },
  });
  return {
    success: true, verb: 'create', mode: 'sql', table, newId, rowsAffected, plannedRows, cacheFlushed,
    executed_sql: checked.sql !== params.sql ? checked.sql : undefined,
    preflight_warnings: checked.warnings.length ? checked.warnings : undefined,
    verified, verification_note: verificationNote,
    auditId, auditLogged, operator,
  };
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
  reason?: string;
  allowBulk?: boolean;
}

export const rockEditSchema = {
  name: 'rock_edit',
  description:
    'EDIT an EXISTING Rock object — a HARD-STOP, two-phase action ("edit = stop"). ' +
    'Call WITHOUT confirmation_token first: this captures a before-snapshot, runs impact analysis ' +
    '(what reports/pages/blocks reference the target), and returns a confirmation_token WITHOUT writing. ' +
    'STOP and show the user the impact + snapshot; only after they approve, re-call with the SAME ' +
    'arguments (including the same reason) plus the confirmation_token to execute. mode:"rest" PATCHes ' +
    'controller/{id} with a partial body; mode:"sql" runs a single UPDATE and REQUIRES snapshotQuery (a ' +
    'SELECT capturing the rows it will change) so the change is reversible. mode:"sql" also passes the ' +
    'SQL preflight and Auth-table guard (warnings shown in the preview). The UPDATE\'s own WHERE must match ' +
    'the same number of rows as snapshotQuery, that count is checked against the bulk limit ' +
    '(ROCK_MCP_BULK_WRITE_MAX, default 25; more needs allowBulk:true), and on execute the UPDATE runs in a ' +
    'transaction that rolls back if it changes more rows than the snapshot holds. ' +
    'The execute result says verified:true/false from a re-read.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['rest', 'sql'], description: '"rest" (PATCH) or "sql" (UPDATE)' },
      controller: { type: 'string', description: 'REST controller for mode:"rest", e.g. "Blocks"' },
      id: { type: ['string', 'number'], description: 'Target id for mode:"rest"' },
      body: { type: 'object', description: 'Partial update body (PascalCase) for mode:"rest"' },
      sql: { type: 'string', description: 'A single UPDATE statement for mode:"sql"' },
      snapshotQuery: { type: 'string', description: 'mode:"sql": a SELECT capturing exactly the rows the UPDATE will change (required, for reversibility; its row count must match the UPDATE\'s own WHERE and is checked against the bulk limit)' },
      confirmation_token: { type: 'string', description: 'Omit on the first (preview) call; pass the returned token on the second (execute) call' },
      label: { type: 'string', description: 'Optional human label recorded in the audit ledger' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on the audit ledger entry alongside the ' +
          'operator\'s git identity, so "did my session touch prod?" is answerable later. Pass ' +
          'the same value on both the preview and execute calls if you want it on the executed record.',
      },
      reason: REASON_PARAM,
      allowBulk: ALLOW_BULK_PARAM,
    },
    required: ['mode', 'reason'],
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
  const sqlTable = params.mode === 'sql' && params.sql ? tableFromWrite(params.sql) : undefined;
  const refusalTarget: AuditRecord['target'] =
    params.mode === 'rest'
      ? { entityType: params.controller ? normalizeEntityType(params.controller) : 'unknown', id: params.id }
      : { entityType: sqlTable ? normalizeEntityType(sqlTable) : 'unknown', table: sqlTable };

  // ---- Phase 2: execute (token present) ----
  if (params.confirmation_token) {
    if (!validateToken(op, params.confirmation_token)) {
      throw new WriteRefused(
        'Confirmation token mismatch — arguments or reason changed since the preview, or the preview was skipped. ' +
          'Nothing was written. Re-call rock_edit WITHOUT a token to get a fresh preview.',
        refusalTarget
      );
    }
    if (params.mode === 'rest') {
      if (!params.controller || params.id === undefined || !params.body) {
        throw new Error('rock_edit (mode:"rest") requires controller, id, and body.');
      }
      const controller = params.controller;
      const id = params.id;
      const body = params.body;
      const snap = await captureRestSnapshot(client, controller, id, ts);
      const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
      await client.v1Patch(`${controller}/${id}`, body);
      const rb = await readBack(async () => {
        const after = await client.v1Get<unknown>(`${controller}/${id}`);
        return { verified: fieldsMatch(after, body), after };
      });
      const auditId = shortHash(token);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_edit', verb: 'edit', mode: 'rest',
        target: { entityType: normalizeEntityType(controller), id }, snapshotRef: snapRef,
        payload: { label: params.label, body }, confirmationToken: params.confirmation_token,
        result: { success: true, verified: rb.verified },
      });
      return {
        phase: 'executed', success: true, verb: 'edit', mode: 'rest', controller, id, before_snapshot_ref: snapRef,
        before: snap.data, after: rb.after, verified: rb.verified, verification_note: rb.verification_note,
        auditId, auditLogged, operator,
      };
    }
    // sql edit
    if (!params.sql) throw new Error('rock_edit (mode:"sql") requires sql.');
    if (!params.snapshotQuery) throw new Error('rock_edit (mode:"sql") requires snapshotQuery for reversibility.');
    const checked = await sqlWriteChecks(client, params.sql, 'edit', refusalTarget);
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    const beforeRows = snapshotRowCount(snap.data);
    await sqlRowChecks(client, checked.sql, beforeRows, 'rock_edit UPDATE', refusalTarget);
    const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
    const rowsAffected = await runGuardedSql(client, checked.sql, beforeRows, 'rock_edit UPDATE', refusalTarget);
    const snapshotQuery = params.snapshotQuery;
    const rb = await readBack(async () => {
      const after = await client.executeSql<unknown>(snapshotQuery);
      return {
        verified: rowsAffected === beforeRows,
        after,
        note:
          rowsAffected === beforeRows
            ? undefined
            : `The UPDATE reported ${rowsAffected} row(s) changed but the snapshot matched ${beforeRows}. ${UNCERTAIN_OUTCOME_NOTE}`,
      };
    });
    const auditId = shortHash(token);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_edit', verb: 'edit', mode: 'sql',
      target: { entityType: sqlTable ? normalizeEntityType(sqlTable) : 'unknown', table: sqlTable }, snapshotRef: snapRef,
      payload: { label: params.label, sql: params.sql, executedSql: checked.sql !== params.sql ? checked.sql : undefined },
      confirmationToken: params.confirmation_token,
      result: { success: true, rowsAffected, verified: rb.verified },
    });
    return {
      phase: 'executed', success: true, verb: 'edit', mode: 'sql', table: sqlTable, rowsAffected,
      executed_sql: checked.sql !== params.sql ? checked.sql : undefined,
      before_snapshot_ref: snapRef, before: snap.data, after: rb.after,
      verified: rb.verified, verification_note: rb.verification_note,
      auditId, auditLogged, operator,
    };
  }

  // ---- Phase 1: preview (no token) ----
  let snapshotData: unknown;
  let target: ImpactTarget;
  let rowCount = 1;
  let sqlWarnings: string[] = [];
  let executedSql: string | undefined;
  let rowCountCheck: string | undefined;
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
    if (!params.snapshotQuery) throw new Error('rock_edit (mode:"sql") requires snapshotQuery (a SELECT of the rows the UPDATE will change).');
    const checked = await sqlWriteChecks(client, params.sql, 'edit', refusalTarget);
    sqlWarnings = checked.warnings;
    executedSql = checked.sql !== params.sql ? checked.sql : undefined;
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    snapshotData = snap.data;
    rowCount = snapshotRowCount(snap.data);
    const rc = await sqlRowChecks(client, checked.sql, rowCount, 'rock_edit UPDATE', refusalTarget);
    rowCountCheck =
      rc.statementRows !== null
        ? `The statement's own WHERE matches the same ${rowCount} row(s) as snapshotQuery.`
        : `Could not count rows from the statement itself (joins, aliases or TOP); on execute it runs in a transaction that rolls back if it changes more than ${rowCount} row(s).`;
    target = { entityType: sqlTable ? normalizeEntityType(sqlTable) : 'unknown', table: sqlTable };
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
        : { mode: 'sql', sql: params.sql, executed_sql: executedSql },
    rows_affected: rowCount,
    row_count_check: rowCountCheck,
    preflight_warnings: sqlWarnings.length ? sqlWarnings : undefined,
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
  reason?: string;
  allowBulk?: boolean;
}

export const rockDeleteSchema = {
  name: 'rock_delete',
  description:
    'DELETE an EXISTING Rock object — a HARD-STOP, two-phase action (same handshake as rock_edit). ' +
    'PREFERS deactivation: for mode:"rest", if the entity has an IsActive field and hard is not true, ' +
    'it sets IsActive=false (trivially reversible) instead of hard-deleting. Pass hard:true to force a ' +
    'real DELETE. Call WITHOUT confirmation_token first to get the impact analysis + before-snapshot + ' +
    'token; show the user, then re-call with the token to execute. mode:"sql" runs a single DELETE and ' +
    'REQUIRES snapshotQuery (a SELECT of the rows it will remove) so the row can be re-created on revert; ' +
    'it also passes the SQL preflight and Auth-table guard. The DELETE\'s own WHERE must match the same ' +
    'number of rows as snapshotQuery, that count is checked against the bulk limit (ROCK_MCP_BULK_WRITE_MAX, ' +
    'default 25; more needs allowBulk:true), and on execute the DELETE runs in a transaction that rolls back ' +
    'if it removes more rows than the snapshot holds. The execute result ' +
    'says verified:true/false from a re-read.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['rest', 'sql'], description: '"rest" (DELETE/deactivate) or "sql" (DELETE)' },
      controller: { type: 'string', description: 'REST controller for mode:"rest"' },
      id: { type: ['string', 'number'], description: 'Target id for mode:"rest"' },
      sql: { type: 'string', description: 'A single DELETE statement for mode:"sql"' },
      snapshotQuery: { type: 'string', description: 'mode:"sql": a SELECT capturing exactly the rows the DELETE will remove (required; its row count must match the DELETE\'s own WHERE and is checked against the bulk limit)' },
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
      reason: REASON_PARAM,
      allowBulk: ALLOW_BULK_PARAM,
    },
    required: ['mode', 'reason'],
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
  const sqlTable = params.mode === 'sql' && params.sql ? tableFromWrite(params.sql) : undefined;
  const refusalTarget: AuditRecord['target'] =
    params.mode === 'rest'
      ? { entityType: params.controller ? normalizeEntityType(params.controller) : 'unknown', id: params.id }
      : { entityType: sqlTable ? normalizeEntityType(sqlTable) : 'unknown', table: sqlTable };

  // ---- Phase 2: execute ----
  if (params.confirmation_token) {
    if (!validateToken(op, params.confirmation_token)) {
      throw new WriteRefused(
        'Confirmation token mismatch — arguments or reason changed since the preview, or the preview was skipped. ' +
          'Nothing was written. Re-call rock_delete WITHOUT a token to get a fresh preview.',
        refusalTarget
      );
    }
    if (params.mode === 'rest') {
      if (!params.controller || params.id === undefined) {
        throw new Error('rock_delete (mode:"rest") requires controller and id.');
      }
      const controller = params.controller;
      const id = params.id;
      const snap = await captureRestSnapshot(client, controller, id, ts);
      const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
      const row = snap.data as Record<string, unknown>;
      const canDeactivate = !params.hard && row && Object.prototype.hasOwnProperty.call(row, 'IsActive');
      let action: 'deactivated' | 'deleted';
      if (canDeactivate) {
        await client.v1Patch(`${controller}/${id}`, { IsActive: false });
        action = 'deactivated';
      } else {
        await client.v1Delete(`${controller}/${id}`);
        action = 'deleted';
      }
      const rb = await readBack(async () => {
        const after = await v1GetOrNull<Record<string, unknown>>(client, `${controller}/${id}`);
        if (action === 'deactivated') return { verified: !!after && after.IsActive === false, after };
        // Some Rock controllers soft-delete on DELETE (IsActive=0, row remains) — count that as done.
        return {
          verified: after == null || after.IsActive === false,
          after: after ?? undefined,
          note: after != null && after.IsActive === false ? 'Rock kept the row and set IsActive=false (soft delete).' : undefined,
        };
      });
      const auditId = shortHash(token);
      const auditLogged = await appendAudit({
        auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_delete', verb: 'delete', mode: 'rest',
        target: { entityType: normalizeEntityType(controller), id }, snapshotRef: snapRef,
        payload: { label: params.label, action, hard: !!params.hard }, confirmationToken: params.confirmation_token,
        result: { success: true, verified: rb.verified },
      });
      return {
        phase: 'executed', success: true, verb: 'delete', mode: 'rest', action, controller, id, before_snapshot_ref: snapRef,
        before: snap.data, verified: rb.verified, verification_note: rb.verification_note, auditId, auditLogged, operator,
      };
    }
    // sql delete
    if (!params.sql) throw new Error('rock_delete (mode:"sql") requires sql.');
    if (!params.snapshotQuery) throw new Error('rock_delete (mode:"sql") requires snapshotQuery for reversibility.');
    const checked = await sqlWriteChecks(client, params.sql, 'delete', refusalTarget);
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    const beforeRows = snapshotRowCount(snap.data);
    await sqlRowChecks(client, checked.sql, beforeRows, 'rock_delete DELETE', refusalTarget);
    const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);
    const rowsAffected = await runGuardedSql(client, checked.sql, beforeRows, 'rock_delete DELETE', refusalTarget);
    const snapshotQuery = params.snapshotQuery;
    const rb = await readBack(async () => {
      const after = await client.executeSql<unknown>(snapshotQuery);
      const left = snapshotRowCount(after);
      return {
        verified: left === 0,
        after,
        note: left === 0 ? undefined : `${left} row(s) still match the snapshot query after the DELETE. ${UNCERTAIN_OUTCOME_NOTE}`,
      };
    });
    const auditId = shortHash(token);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'executed', operator, sessionTag, tool: 'rock_delete', verb: 'delete', mode: 'sql',
      target: { entityType: sqlTable ? normalizeEntityType(sqlTable) : 'unknown', table: sqlTable }, snapshotRef: snapRef,
      payload: { label: params.label, sql: params.sql, executedSql: checked.sql !== params.sql ? checked.sql : undefined },
      confirmationToken: params.confirmation_token,
      result: { success: true, rowsAffected, verified: rb.verified },
    });
    return {
      phase: 'executed', success: true, verb: 'delete', mode: 'sql', table: sqlTable, rowsAffected,
      executed_sql: checked.sql !== params.sql ? checked.sql : undefined,
      before_snapshot_ref: snapRef, before: snap.data, verified: rb.verified, verification_note: rb.verification_note,
      auditId, auditLogged, operator,
    };
  }

  // ---- Phase 1: preview ----
  let snapshotData: unknown;
  let target: ImpactTarget;
  let willDeactivate = false;
  let rowCount = 1;
  let sqlWarnings: string[] = [];
  let executedSql: string | undefined;
  let rowCountCheck: string | undefined;
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
    if (!params.snapshotQuery) throw new Error('rock_delete (mode:"sql") requires snapshotQuery (a SELECT of the rows the DELETE will remove).');
    const checked = await sqlWriteChecks(client, params.sql, 'delete', refusalTarget);
    sqlWarnings = checked.warnings;
    executedSql = checked.sql !== params.sql ? checked.sql : undefined;
    const snap = await captureSqlSnapshot(client, params.snapshotQuery, ts);
    snapshotData = snap.data;
    rowCount = snapshotRowCount(snap.data);
    const rc = await sqlRowChecks(client, checked.sql, rowCount, 'rock_delete DELETE', refusalTarget);
    rowCountCheck =
      rc.statementRows !== null
        ? `The statement's own WHERE matches the same ${rowCount} row(s) as snapshotQuery.`
        : `Could not count rows from the statement itself (joins, aliases or TOP); on execute it runs in a transaction that rolls back if it changes more than ${rowCount} row(s).`;
    target = { entityType: sqlTable ? normalizeEntityType(sqlTable) : 'unknown', table: sqlTable };
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
        : { mode: 'sql', sql: params.sql, executed_sql: executedSql },
    rows_affected: rowCount,
    row_count_check: rowCountCheck,
    preflight_warnings: sqlWarnings.length ? sqlWarnings : undefined,
    before_snapshot: snapshotData,
    impact,
    next_step:
      'STOP. Show the user the impact analysis and before-snapshot above. Only after they approve, ' +
      're-call rock_delete with the SAME arguments plus this confirmation_token to execute.',
    operator,
  };
}
