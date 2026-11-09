/**
 * Small helpers shared by the older data-write tools for their before-snapshots and read-backs.
 */

import { RockClient } from '../rock-client.js';
import { REASON_PARAM, CONFIRMATION_TOKEN_PARAM, SESSION_TAG_PARAM, LABEL_PARAM, ALLOW_BULK_PARAM } from '../safety/index.js';

/** Keep only the listed keys (plus Id and Guid) of a v1 row — the before-state rock_restore needs. */
export function pickFields(row: unknown, keys: string[]): Record<string, unknown> {
  const src = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['Id', 'Guid', ...keys]) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

/** Loose field compare (Rock round-trips numbers/booleans/dates in varying shapes). */
export function fieldsMatch(row: unknown, expected: Record<string, unknown>): boolean {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    const got = r[k];
    if (got === v) continue;
    if (got == null && (v == null || v === '')) continue;
    if (v == null && got === '') continue;
    if (String(got) === String(v)) continue;
    // ISO date vs Rock datetime string ("2026-04-12" vs "2026-04-12T00:00:00")
    if (typeof got === 'string' && typeof v === 'string' && got.startsWith(v)) continue;
    return false;
  }
  return true;
}

/** v1 GET that returns null on a 404 (row gone) and rethrows anything else. */
export async function v1GetOrNull<T>(client: RockClient, path: string): Promise<T | null> {
  try {
    return await client.v1Get<T>(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/→\s*404/.test(msg)) return null;
    throw e;
  }
}

/** Rock v1 POST responses vary (bare number, {Id}, or the entity) — normalize to an Id. */
export function idFrom(res: unknown): number | null {
  if (typeof res === 'number' && Number.isFinite(res)) return res;
  if (typeof res === 'string' && /^\d+$/.test(res.trim())) return Number(res.trim());
  if (res && typeof res === 'object') {
    const cand = (res as Record<string, unknown>).Id ?? (res as Record<string, unknown>).id;
    if (typeof cand === 'number' && Number.isFinite(cand)) return cand;
    if (typeof cand === 'string' && /^\d+$/.test(cand)) return Number(cand);
  }
  return null;
}

/** Read-back for a create: the new row can be fetched by Id. */
export async function createdRowExists(client: RockClient, controller: string, id: number | null) {
  if (id == null) {
    return { verified: false, note: `${controller} POST returned no Id, so the new row could not be re-read.` };
  }
  const row = await v1GetOrNull<unknown>(client, `${controller}/${id}`);
  return { verified: row != null, after: row ?? undefined };
}

// -----------------------------
// Shared write-call params (reason, two-phase token, ledger tags)
// -----------------------------

export interface WriteCallParams {
  reason?: string;
  session_tag?: string;
  label?: string;
  allowBulk?: boolean;
}
export interface TwoPhaseCallParams extends WriteCallParams {
  confirmation_token?: string;
}

export const CREATE_CALL_PROPS = { reason: REASON_PARAM, session_tag: SESSION_TAG_PARAM, label: LABEL_PARAM };
export const TWO_PHASE_CALL_PROPS = { ...CREATE_CALL_PROPS, confirmation_token: CONFIRMATION_TOKEN_PARAM };
export const TWO_PHASE_NOTE =
  ' Two-phase: the first call returns a preview (intended change, before-state, confirmation_token) and writes ' +
  'nothing; show it to the user, then re-call with the SAME arguments plus confirmation_token to execute. ' +
  'Undo with rock_restore.';
export const CREATE_NOTE = ' Runs at once and is recorded in the audit ledger; undo with rock_restore.';

export { ALLOW_BULK_PARAM };

