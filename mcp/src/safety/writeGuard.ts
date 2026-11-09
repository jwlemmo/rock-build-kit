/**
 * Rules every write tool shares, applied in one place (index.ts routes every write call
 * through runWriteTool):
 *
 *   - reason: every write call must say why. An empty reason is refused before anything runs.
 *     The reason is part of the confirmation token (confirm.ts) and is stamped on every ledger
 *     record the call writes (audit.ts), via the write context (writeContext.ts).
 *   - bundle gate: on the dev server, build writes need an open change bundle (bundleGate.ts,
 *     same behavior as the Build Kit).
 *   - bulk cap: a single call may not touch more than ROCK_MCP_BULK_WRITE_MAX rows (default 25)
 *     unless it passes allowBulk:true. Tools call enforceBulkCap with their row count.
 *   - refusals are ledgered: anything that refuses a write throws WriteRefused, and the refusal
 *     is appended to the ledger as a phase:'denied' record (tool, target, why).
 *   - read-back: readBack() wraps the re-read after a write, so every executed write reports
 *     verified:true/false and never retries on its own.
 */

import { createHash } from 'node:crypto';
import { appendAudit } from './audit.js';
import { resolveGitIdentity } from './gitIdentity.js';
import { checkBundleGate } from './bundleGate.js';
import { runInWriteContext, currentWriteContext, type WriteContext } from './writeContext.js';
import type { AuditRecord, Verb } from './types.js';

/** Every tool that writes to Rock, with the verb its ledger records use by default. */
export const WRITE_TOOLS: Readonly<Record<string, Verb>> = {
  update_person: 'edit',
  update_person_address: 'edit',
  update_person_phone: 'edit',
  add_person_tag: 'create',
  remove_person_tag: 'delete',
  set_person_attribute: 'edit',
  add_group_member: 'create',
  remove_group_member: 'delete',
  update_group: 'edit',
  record_attendance: 'create',
  add_note: 'create',
  record_step: 'create',
  launch_workflow: 'create',
  create_reservation: 'create',
  update_reservation: 'edit',
  rock_create: 'create',
  rock_edit: 'edit',
  rock_delete: 'delete',
  rock_restore: 'edit',
  edit_block_content: 'edit',
  create_page_bundle: 'create',
  upsert_metric_value: 'edit',
};

export function isWriteTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool);
}

/** Thrown for any refused write. runWriteTool ledgers it as phase:'denied', then rethrows. */
export class WriteRefused extends Error {
  readonly target?: AuditRecord['target'];
  constructor(message: string, target?: AuditRecord['target']) {
    super(message);
    this.name = 'WriteRefused';
    this.target = target;
  }
}

/** The bulk limit: ROCK_MCP_BULK_WRITE_MAX, default 25. */
export const DEFAULT_BULK_WRITE_MAX = 25;
export function bulkWriteMax(): number {
  const n = Number(process.env.ROCK_MCP_BULK_WRITE_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BULK_WRITE_MAX;
}

/**
 * Refuse when `count` rows is over the bulk limit and the call did not pass allowBulk:true.
 * A null count means the tool could not count the rows; that is refused too unless allowBulk.
 */
export function enforceBulkCap(count: number | null, what: string, target?: AuditRecord['target']): void {
  if (currentWriteContext()?.allowBulk) return;
  const max = bulkWriteMax();
  if (count === null) {
    throw new WriteRefused(
      `Refused: could not count the rows this ${what} would touch, so it cannot be checked against the ` +
        `bulk limit of ${max} (ROCK_MCP_BULK_WRITE_MAX). Nothing was written. If the write is intended, ` +
        're-call with allowBulk:true and a reason that says why.',
      target
    );
  }
  if (count > max) {
    throw new WriteRefused(
      `Refused: this ${what} would touch ${count} rows, over the bulk limit of ${max} ` +
        '(ROCK_MCP_BULK_WRITE_MAX). Nothing was written. If that many rows is intended, re-call with ' +
        'allowBulk:true and a reason that says why.',
      target
    );
  }
}

/** Text added to any result whose outcome could not be confirmed. */
export const UNCERTAIN_OUTCOME_NOTE =
  'The outcome of this write could not be confirmed. Check the target in Rock (execute_sql or the admin UI) ' +
  'before trying again — this tool never retries a write on its own, and a blind retry can duplicate or overwrite it.';

export interface ReadBackResult {
  verified: boolean;
  after?: unknown;
  verification_note?: string;
}

/** Run the re-read after a write. A failed re-read is verified:false with a note, never a thrown error. */
export async function readBack(
  fn: () => Promise<{ verified: boolean; after?: unknown; note?: string }>
): Promise<ReadBackResult> {
  try {
    const r = await fn();
    return {
      verified: r.verified,
      after: r.after,
      verification_note: r.note ?? (r.verified ? undefined : UNCERTAIN_OUTCOME_NOTE),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { verified: false, verification_note: `Re-read after the write failed (${msg.slice(0, 300)}). ${UNCERTAIN_OUTCOME_NOTE}` };
  }
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Args as recorded on a denied record: no token, long strings cut so page content can't bloat the ledger. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'confirmation_token') continue;
    if (typeof v === 'string' && v.length > 500) out[k] = `${v.slice(0, 500)}… (${v.length} chars)`;
    else out[k] = v;
  }
  return out;
}

/** Best-effort target for a denied record, from the call's own arguments. */
export function targetFromArgs(tool: string, args: Record<string, unknown>): AuditRecord['target'] {
  const pick = (...keys: string[]): string | number | undefined => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'number' || (typeof v === 'string' && v !== '')) return v;
    }
    return undefined;
  };
  switch (tool) {
    case 'update_person':
      return { entityType: 'Person', id: pick('id') };
    case 'update_person_address':
    case 'update_person_phone':
    case 'add_person_tag':
    case 'remove_person_tag':
    case 'set_person_attribute':
    case 'record_step':
      return { entityType: 'Person', id: pick('personId') };
    case 'add_group_member':
    case 'remove_group_member':
    case 'record_attendance':
      return { entityType: 'Group', id: pick('groupId') };
    case 'update_group':
      return { entityType: 'Group', id: pick('id') };
    case 'add_note':
      return { entityType: typeof args.entityType === 'string' ? args.entityType : 'Person', id: pick('personId', 'entityId') };
    case 'launch_workflow':
      return { entityType: 'WorkflowType', id: pick('workflowTypeId') };
    case 'create_reservation':
      return { entityType: 'Reservation' };
    case 'update_reservation':
      return { entityType: 'Reservation', id: pick('id') };
    case 'edit_block_content':
      return args.html_content_id !== undefined
        ? { entityType: 'HtmlContent', id: pick('html_content_id') }
        : { entityType: 'Block', id: pick('block_id') };
    case 'create_page_bundle':
      return { entityType: 'Page', id: pick('parent_page_id') };
    case 'upsert_metric_value':
      return { entityType: 'Metric', id: pick('metricId') };
    case 'rock_restore':
      return { entityType: 'AuditRecord', id: pick('audit_id') };
    default: {
      const controller = typeof args.controller === 'string' ? args.controller : undefined;
      const sql = typeof args.sql === 'string' ? args.sql : undefined;
      const table = sql?.replace(/\s+/g, ' ').trim().match(/^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DELETE)\s+\[?(\w+)\]?/i)?.[1];
      return { entityType: controller ?? table ?? 'unknown', id: pick('id'), table };
    }
  }
}

/** Append a phase:'denied' record. Never throws (a failed ledger append must not mask the refusal). */
export async function logDenial(
  tool: string,
  args: Record<string, unknown>,
  why: string,
  target?: AuditRecord['target']
): Promise<boolean> {
  const ts = new Date().toISOString();
  const ctx = currentWriteContext();
  try {
    return await appendAudit({
      auditId: shortHash(`denied|${tool}|${ts}|${why}|${JSON.stringify(args).slice(0, 2000)}`),
      ts,
      phase: 'denied',
      operator: resolveGitIdentity(),
      sessionTag: typeof args.session_tag === 'string' ? args.session_tag : ctx?.sessionTag,
      tool,
      verb: WRITE_TOOLS[tool] ?? 'edit',
      mode: args.mode === 'sql' ? 'sql' : 'rest',
      target: target ?? targetFromArgs(tool, args),
      reason: typeof args.reason === 'string' ? args.reason : undefined,
      denial: why,
      payload: summarizeArgs(args),
      result: { success: false, error: why },
    });
  } catch {
    return false;
  }
}

/**
 * Run one write-tool call under the shared rules. Non-write tools pass straight through, as
 * does rock_restore's list mode (no audit_id — it only reads the ledger).
 */
export async function runWriteTool<T>(tool: string, rawArgs: unknown, fn: () => Promise<T>): Promise<T> {
  if (!isWriteTool(tool)) return fn();
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  if (tool === 'rock_restore' && !args.audit_id) return fn();

  const ctx: WriteContext = {
    tool,
    reason: typeof args.reason === 'string' ? args.reason.trim() : '',
    sessionTag: typeof args.session_tag === 'string' ? args.session_tag : undefined,
    allowBulk: args.allowBulk === true,
  };

  const gate = checkBundleGate(tool);
  if (gate) {
    await logDenial(tool, args, gate);
    throw new WriteRefused(gate);
  }

  if (!ctx.reason) {
    const why =
      `Refused: ${tool} requires a non-empty "reason" — one plain sentence saying why this write is being made ` +
      '(it is recorded in the audit ledger). Nothing was written. Re-call with reason set.';
    await logDenial(tool, args, why);
    throw new WriteRefused(why);
  }

  try {
    return await runInWriteContext(ctx, fn);
  } catch (e) {
    if (e instanceof WriteRefused) {
      await runInWriteContext(ctx, () => logDenial(tool, args, e.message, e.target));
    }
    throw e;
  }
}

/** Shared JSON-schema fragment for the reason parameter. */
export const REASON_PARAM = {
  type: 'string',
  description:
    'Required: one plain sentence saying why this write is being made. Recorded in the audit ledger and ' +
    'part of the confirmation token (a changed reason needs a fresh preview). An empty reason is refused.',
} as const;

/** Shared JSON-schema fragment for the allowBulk parameter. */
export const ALLOW_BULK_PARAM = {
  type: 'boolean',
  description:
    'Set true only when one call must touch more than the bulk limit (ROCK_MCP_BULK_WRITE_MAX, default 25 rows). ' +
    'Without it such a call is refused. Requires a reason that says why.',
} as const;

/** Shared JSON-schema fragments for the older data-write tools. */
export const CONFIRMATION_TOKEN_PARAM = {
  type: 'string',
  description: 'Omit on the first (preview) call; pass the returned token on the second (execute) call with otherwise identical arguments.',
} as const;
export const SESSION_TAG_PARAM = {
  type: 'string',
  description: 'Optional: your Claude session id, recorded on the audit ledger entry so "did my session touch prod?" is answerable later.',
} as const;
export const LABEL_PARAM = { type: 'string', description: 'Optional human label recorded in the audit ledger.' } as const;
