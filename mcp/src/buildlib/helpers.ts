/**
 * Small stand-alone helpers for src/buildlib/ — see index.ts for the module overview.
 * No RockClient/ledger dependencies here; these are pure functions plus thin console logging.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- SQL literal helpers
// Mirrors new-hire-onboarding/build/wf.mjs:12-14 (esc/bit/sqlVal) — used by
// createWorkflowAction's INSERT builder. The Lava `{% sql statement:'command' %}` path
// inlines values (no bound params), so every literal must be escaped here, not left to
// the caller.

/** SQL string-literal escape (doubles embedded single quotes, T-SQL style). */
export function esc(s: unknown): string {
  return String(s).replace(/'/g, "''");
}

/** SQL BIT literal from a JS boolean. */
export function bit(b: boolean): 0 | 1 {
  return b ? 1 : 0;
}

/** A nullable N'...' SQL literal — `null`/`undefined` becomes the SQL keyword NULL. */
export function sqlVal(v: string | number | null | undefined): string {
  return v === null || v === undefined ? 'NULL' : `N'${esc(v)}'`;
}

// ---------------------------------------------------------------- wall-clock ISO formatter
//
// Ported verbatim (semantics) from room-calendar/build/admin.block.html:1378-1381
// (isoNoZ/localISO). WHY this exists at all: Rock's own datetime columns (ApprovedDateTime,
// ModifiedDateTime, MetricValueDateTime, etc.) are written and read back as server-LOCAL
// wall-clock time, not UTC — Rock does no timezone conversion on these columns. Date.
// toISOString() always renders the UTC instant (with a trailing "Z"), so PATCHing
// `{ ApprovedDateTime: new Date().toISOString() }` silently writes a timestamp shifted by
// the server's UTC offset (this repo's rock-client.ts already uses `new Date().
// toISOString()` for these fields today, riding on the historical assumption the Rock box
// runs UTC — a build script pointed at a non-UTC front-end must NOT make that assumption).
// localISO builds the string from the Date object's LOCAL getters (getFullYear/getMonth/…)
// instead, producing "yyyy-MM-ddTHH:mm:ss" with no "Z" — exactly what a Rock datetime column
// expects when the caller's clock matches the server's.

/** Zero-pad to 2 digits. */
function p2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Format a Date as a wall-clock "yyyy-MM-ddTHH:mm:ss" string (NO trailing "Z"), using the
 * Date object's LOCAL getters — not toISOString(), which would render the UTC instant.
 * Use this for every Rock datetime column a build script writes (ApprovedDateTime,
 * ModifiedDateTime, MetricValueDateTime, …).
 */
export function localISO(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    p2(d.getMonth() + 1) +
    '-' +
    p2(d.getDate()) +
    'T' +
    p2(d.getHours()) +
    ':' +
    p2(d.getMinutes()) +
    ':' +
    p2(d.getSeconds())
  );
}

// ---------------------------------------------------------------- logging vocabulary
// The corpora's symbol vocabulary (✓ created, ✗ removed/failed, · reused/no-op) — thin
// wrappers over console.log, no color/formatting dependencies. See 01-category-and-role.mjs
// (`log`), r2-01-launch-recipients.mjs ("already correct — no change"), 13-cleanup-test-
// data.mjs (✗ per deleted row).

/** Plain informational line. */
export function log(...args: unknown[]): void {
  console.log(...args);
}

/** ✓ — something was created/changed. */
export function ok(...args: unknown[]): void {
  console.log('✓', ...args);
}

/** · — something already existed / was a no-op (reused, not modified). */
export function skip(...args: unknown[]): void {
  console.log('·', ...args);
}

/** ✗ — something failed (or, in the corpora's delete scripts, was removed). */
export function fail(...args: unknown[]): void {
  console.log('✗', ...args);
}

// ---------------------------------------------------------------- misc

/** Short, stable hash for auditId derivation (mirrors rock-write.ts's shortHash). */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Current timestamp as ISO (UTC instant) — for ledger `ts` fields, which are metadata
 *  about when the tool ran, not a Rock column, so toISOString() is correct here (contrast
 *  with localISO, which is for values WRITTEN to Rock datetime columns). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Best-effort extraction of a numeric/string Id from a v1Post-style response shape. */
export function newIdFrom(res: unknown): string | number | null {
  if (typeof res === 'number') return res;
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    const v = o.Id ?? o.id ?? null;
    return typeof v === 'number' || typeof v === 'string' ? v : null;
  }
  const n = Number(res);
  return Number.isFinite(n) ? n : null;
}
