/**
 * Preflight checks for the guarded write path (rock_create/edit/delete, mode:"sql").
 *
 * Runs BEFORE executeSqlCommand and catches the raw-SQL mistakes that Rock's own model layer
 * would normally prevent (sources: Spark's Rock SQL skill — .claude/skills/sql in
 * SparkDevNetwork/Rock, incl. references/schema-patterns.md — and our build kit's
 * reference/rock-field-notes.md "SQL" section):
 *
 *   - INSERT: the target table's columns are read from INFORMATION_SCHEMA (cached per process,
 *     per target). Missing NOT NULL columns with no default, unknown columns, and an IsSystem
 *     column on a table that has none are errors.
 *   - GETDATE()/SYSDATETIME() (and the other server-clock functions) are errors: they read the
 *     database server's clock, which need not match the time zone Rock stores its datetimes in
 *     (hosted SQL is often UTC), so a row written with them can land hours off. The fix is a
 *     "now" expression in Rock's own time zone, built from ROCK_TIMEZONE (a Windows time-zone
 *     id such as 'Eastern Standard Time' — whatever the Rock server is configured with). When
 *     ROCK_TIMEZONE is unset the kit does not guess: the error says how to set it.
 *   - The only rewrite this module ever makes: on an INSERT, it ADDS missing CreatedDateTime /
 *     ModifiedDateTime (the ROCK_TIMEZONE "now" expression, only when ROCK_TIMEZONE is set) and
 *     CreatedByPersonAliasId / ModifiedByPersonAliasId (the primary alias of the person who owns
 *     the API key in use — give each operator their own key) when the table has those columns.
 *     Each addition is reported as a warning. UPDATEs are never rewritten; a missing
 *     ModifiedDateTime / ModifiedByPersonAliasId is a warning.
 *   - GroupMember INSERT must list GroupTypeId (a denormalized copy of the group's type that
 *     raw SQL does not fill); a missing DateTimeAdded is a warning.
 *   - The result is re-checked with validateWrite(), so nothing here can loosen
 *     sql-write-validator.ts.
 */

import type { RockClient } from '../rock-client.js';
import { removeComments } from '../sql-validator.js';
import { validateWrite, type WriteMode } from '../sql-write-validator.js';

export type RockTarget = 'prod' | 'dev';

export interface PreflightContext {
  client: RockClient;
  target: RockTarget;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The SQL to execute: the input (comments stripped) plus any added audit columns. */
  sql: string;
}

/** What to do when ROCK_TIMEZONE is missing or malformed. */
export const TIMEZONE_HELP =
  "Set ROCK_TIMEZONE to the Rock server's configured time zone as a Windows time-zone id (the OrgTimeZone " +
  "value in Rock's web.config, e.g. 'Eastern Standard Time' or 'Pacific Standard Time'), then restart the MCP server. " +
  'This kit does not assume a time zone.';

/**
 * The Rock server's time zone from ROCK_TIMEZONE (a Windows time-zone id), or undefined when unset
 * or not a plausible id. Read on every call so tests and restarts pick up changes.
 */
export function rockTimeZone(): string | undefined {
  const tz = process.env.ROCK_TIMEZONE?.trim();
  return tz && /^[A-Za-z0-9][A-Za-z0-9 .+\-()]{0,63}$/.test(tz) ? tz : undefined;
}

/**
 * "Now" in Rock's time zone as a plain datetime (handles daylight saving), for use instead of
 * GETDATE(). Undefined when ROCK_TIMEZONE is not set.
 */
export function rockNowSql(): string | undefined {
  const tz = rockTimeZone();
  return tz ? `CAST(SYSDATETIMEOFFSET() AT TIME ZONE '${tz}' AS datetime)` : undefined;
}

// Server-clock functions. SYSDATETIMEOFFSET() is NOT listed: it carries its offset and is the
// base of rockNowSql().
const SERVER_CLOCK = /\b(GETDATE|SYSDATETIME|GETUTCDATE|SYSUTCDATETIME)\s*\(\s*\)|\bCURRENT_TIMESTAMP\b/i;

// ------------------------------------------------------------------ small parsing helpers
// Exported for authGuards.ts. Parsing is token-level, not a full T-SQL parser.

/**
 * Replace the inside of every '...' (and "...") literal with spaces, keeping length, so
 * structural scans (parens, commas, keywords) ignore values while indexes still line up
 * with the original string. Bracketed identifiers are kept as-is.
 */
export function maskLiterals(sql: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === quote) {
        if (sql[i + 1] === quote) { out += '  '; i++; continue; }
        quote = null;
        out += c;
        continue;
      }
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    out += c;
  }
  return out;
}

/** Index of the paren that closes the one at `open` (masked text), or -1. */
export function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split `text` on commas at paren depth 0 (masked used for structure). Returns raw pieces + start offsets. */
export function splitTopLevel(text: string, masked: string): Array<{ text: string; start: number }> {
  const parts: Array<{ text: string; start: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), start });
  return parts;
}

/** Find a keyword at paren depth 0 in masked text, starting at `from`. */
export function findTopLevelKeyword(masked: string, keyword: RegExp, from = 0): number {
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

export function normalizeIdent(name: string): string {
  return name.trim().replace(/^\[|\]$/g, '').replace(/^.*\.\[?/, '').replace(/\]$/, '').toLowerCase();
}

export type Literal =
  | { kind: 'null' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'unknown'; text: string };

/** Evaluate a scalar expression only if it is a plain literal; anything else is 'unknown'. */
export function parseLiteral(expr: string): Literal {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')') && matchParen(maskLiterals(e), 0) === e.length - 1) {
    e = e.slice(1, -1).trim();
  }
  if (/^NULL$/i.test(e)) return { kind: 'null' };
  if (/^[+-]?\d+$/.test(e)) return { kind: 'number', value: Number(e) };
  const s = e.match(/^N?'((?:[^']|'')*)'$/i);
  if (s) return { kind: 'string', value: s[1].replace(/''/g, "'") };
  return { kind: 'unknown', text: e };
}

export type WriteVerb = 'INSERT' | 'UPDATE' | 'DELETE';

export function writeVerb(sql: string): WriteVerb | undefined {
  const m = sql.trim().match(/^(INSERT|UPDATE|DELETE)\b/i);
  return m ? (m[1].toUpperCase() as WriteVerb) : undefined;
}

/** Target table named right after the verb (same rule as rock-write.ts tableFromWrite, plus dbo.). */
export function writeTable(sql: string): string | undefined {
  const s = sql.replace(/\s+/g, ' ').trim();
  const id = String.raw`(?:\[?dbo\]?\.)?\[?(\w+)\]?`;
  return (
    s.match(new RegExp(`^INSERT\\s+(?:INTO\\s+)?${id}`, 'i'))?.[1] ??
    s.match(new RegExp(`^UPDATE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s*)?${id}`, 'i'))?.[1] ??
    s.match(new RegExp(`^DELETE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s*)?FROM\\s+${id}`, 'i'))?.[1] ??
    s.match(new RegExp(`^DELETE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s*)?${id}`, 'i'))?.[1]
  );
}

export interface ParsedInsert {
  table: string;
  /** Column names as written (brackets stripped). */
  columns: string[];
  /** Index just after the '(' that opens the column list. */
  columnListInsertAt: number;
  kind: 'values' | 'select';
  /** One array of raw expressions per VALUES tuple, or a single array for INSERT…SELECT. */
  rows: string[][];
  /** Index just after each tuple's '(' (VALUES) or just after SELECT [DISTINCT] [TOP n] (SELECT). */
  rowInsertAt: number[];
  /** Text after the VALUES tuples / select list (e.g. FROM … WHERE NOT EXISTS …). */
  tail: string;
  /** A top-level UNION/INTERSECT/EXCEPT or OUTPUT clause — not safe to rewrite. */
  unsafeToRewrite?: string;
}

/** Parse `INSERT [INTO] T (cols) VALUES (…),(…)` or `INSERT [INTO] T (cols) SELECT …`. */
export function parseInsert(sql: string): ParsedInsert | { error: string } {
  const masked = maskLiterals(sql);
  const head = masked.match(/^\s*INSERT\s+(?:INTO\s+)?((?:\[?dbo\]?\.)?\[?\w+\]?)\s*/i);
  if (!head) return { error: 'Could not find the INSERT target table.' };
  const table = normalizeIdent(head[1]);
  const open = head[0].length;
  if (masked[open] !== '(') {
    return { error: 'INSERT must name its columns explicitly: INSERT INTO Table (Col1, Col2, …) VALUES/SELECT …' };
  }
  const close = matchParen(masked, open);
  if (close < 0) return { error: 'Unbalanced parentheses in the INSERT column list.' };
  const columns = splitTopLevel(sql.slice(open + 1, close), masked.slice(open + 1, close))
    .map((p) => p.text.trim().replace(/^\[|\]$/g, ''))
    .filter((c) => c.length > 0);

  let rest = close + 1;
  let unsafeToRewrite: string | undefined;
  const afterCols = masked.slice(rest);
  if (/^\s*OUTPUT\b/i.test(afterCols)) unsafeToRewrite = 'OUTPUT clause';

  const valuesAt = findTopLevelKeyword(masked, /^VALUES\b/i, rest);
  const selectAt = findTopLevelKeyword(masked, /^SELECT\b/i, rest);
  if (valuesAt >= 0 && (selectAt < 0 || valuesAt < selectAt)) {
    const rows: string[][] = [];
    const rowInsertAt: number[] = [];
    let i = valuesAt + 'VALUES'.length;
    let tailStart = masked.length;
    for (;;) {
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] !== '(') { tailStart = i; break; }
      const end = matchParen(masked, i);
      if (end < 0) return { error: 'Unbalanced parentheses in VALUES.' };
      rows.push(splitTopLevel(sql.slice(i + 1, end), masked.slice(i + 1, end)).map((p) => p.text.trim()));
      rowInsertAt.push(i + 1);
      i = end + 1;
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] === ',') { i++; continue; }
      tailStart = i;
      break;
    }
    return { table, columns, columnListInsertAt: open + 1, kind: 'values', rows, rowInsertAt, tail: sql.slice(tailStart), unsafeToRewrite };
  }
  if (selectAt >= 0) {
    if (findTopLevelKeyword(masked, /^(UNION|INTERSECT|EXCEPT)\b/i, selectAt) >= 0) unsafeToRewrite = 'UNION/INTERSECT/EXCEPT';
    let listStart = selectAt + 'SELECT'.length;
    const mods = masked.slice(listStart).match(/^\s+(?:(?:DISTINCT|ALL)\s+)?(?:TOP\s*(?:\(\s*\d+\s*\)|\d+)(?:\s+PERCENT)?\s+)?/i);
    if (mods) listStart += mods[0].length;
    const fromAt = findTopLevelKeyword(masked, /^(FROM|WHERE|GROUP|ORDER|HAVING)\b/i, listStart);
    const listEnd = fromAt >= 0 ? fromAt : masked.length;
    // A trailing "AS alias" can only be at depth 0 (CAST(x AS int) ends in ')'), so strip it.
    const row = splitTopLevel(sql.slice(listStart, listEnd), masked.slice(listStart, listEnd)).map((p) =>
      p.text.trim().replace(/\s+AS\s+\[?\w+\]?$/i, '').trim()
    );
    return { table, columns, columnListInsertAt: open + 1, kind: 'select', rows: [row], rowInsertAt: [listStart], tail: sql.slice(listEnd), unsafeToRewrite };
  }
  return { error: 'INSERT must use VALUES (…) or SELECT … after its column list.' };
}

// ------------------------------------------------------------------ schema + identity lookups

export interface ColumnInfo {
  name: string;
  nullable: boolean;
  hasDefault: boolean;
  identity: boolean;
  computed: boolean;
}

const columnCache = new Map<string, ColumnInfo[]>();
const aliasCache = new Map<string, { personId: number; aliasId: number }>();

/** For tests: forget cached columns / key-person lookups. */
export function clearPreflightCache(): void {
  columnCache.clear();
  aliasCache.clear();
}

/** Columns of a dbo table, cached per process and per target. Empty array = no such table. */
export async function getTableColumns(client: RockClient, target: RockTarget, table: string): Promise<ColumnInfo[]> {
  if (!/^\w+$/.test(table)) throw new Error(`Unexpected table name "${table}".`);
  const key = `${target}:${table.toLowerCase()}`;
  const hit = columnCache.get(key);
  if (hit) return hit;
  const rows = await client.executeSql<Array<Record<string, unknown>>>(
    "SELECT c.COLUMN_NAME, c.IS_NULLABLE, CASE WHEN c.COLUMN_DEFAULT IS NULL THEN 0 ELSE 1 END AS HasDefault, " +
      "COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IsIdentity, " +
      "COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') AS IsComputed " +
      `FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = '${table}' ORDER BY c.ORDINAL_POSITION`
  );
  const cols: ColumnInfo[] = (Array.isArray(rows) ? rows : []).map((r) => ({
    name: String(r.COLUMN_NAME),
    nullable: String(r.IS_NULLABLE).toUpperCase() === 'YES',
    hasDefault: Number(r.HasDefault) === 1,
    identity: Number(r.IsIdentity) === 1,
    computed: Number(r.IsComputed) === 1,
  }));
  if (cols.length) columnCache.set(key, cols);
  return cols;
}

/**
 * The person who owns the API key this client uses, and that person's primary alias.
 * GET People/GetCurrentPerson returns PrimaryAliasId on Rock 19; fall back to a PersonAlias
 * SELECT if it is missing.
 */
export async function getKeyPerson(client: RockClient, target: RockTarget): Promise<{ personId: number; aliasId: number }> {
  const hit = aliasCache.get(target);
  if (hit) return hit;
  const me = await client.v1Get<Record<string, unknown>>('People/GetCurrentPerson');
  const personId = Number(me?.Id);
  if (!Number.isInteger(personId) || personId <= 0) throw new Error('People/GetCurrentPerson returned no person for this API key.');
  let aliasId = Number(me?.PrimaryAliasId);
  if (!Number.isInteger(aliasId) || aliasId <= 0) {
    const rows = await client.executeSql<Array<Record<string, unknown>>>(
      `SELECT TOP 1 Id FROM PersonAlias WHERE PersonId = ${personId} AND AliasPersonId = ${personId}`
    );
    aliasId = Number(Array.isArray(rows) && rows[0] ? rows[0].Id : NaN);
  }
  if (!Number.isInteger(aliasId) || aliasId <= 0) throw new Error(`No primary PersonAlias found for person ${personId}.`);
  const out = { personId, aliasId };
  aliasCache.set(target, out);
  return out;
}

// ------------------------------------------------------------------ preflight

const MODE_FOR_VERB: Record<WriteVerb, WriteMode> = { INSERT: 'create', UPDATE: 'edit', DELETE: 'delete' };

export async function preflightSqlWrite(sql: string, ctx: PreflightContext): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  // The client strips comments before sending anyway; work on the same text it would send.
  let out = removeComments(sql ?? '').trim();
  const done = (): PreflightResult => ({ ok: errors.length === 0, errors, warnings, sql: out });

  const verb = writeVerb(out);
  if (!verb) {
    errors.push('Write SQL must start with INSERT, UPDATE or DELETE.');
    return done();
  }

  // SET QUOTED_IDENTIFIER ON cannot be prepended: validateWrite() allows exactly ONE statement
  // that starts with the write verb (that rule blocks `INSERT …; DROP …` stacking and is not
  // ours to loosen). The Lava sql command runs on Rock's own SqlClient connection, which
  // already defaults QUOTED_IDENTIFIER to ON, so we only flag it.
  warnings.push(
    'SET QUOTED_IDENTIFIER ON was not prepended: the write path allows a single statement only. ' +
      "Rock's SQL connection defaults it to ON; if the write fails with a SET-options error (filtered index or computed column), run it as a migration instead."
  );

  const masked = maskLiterals(out);
  const now = rockNowSql();
  const clock = masked.match(SERVER_CLOCK);
  if (clock) {
    const fn = clock[0].replace(/\s+/g, '');
    errors.push(
      `${fn} reads the database server's clock, which need not match the time zone Rock stores datetimes in, so the value can land hours off. ` +
        (now ? `Use ${now} instead.` : `Use Rock's own "now" instead. ${TIMEZONE_HELP}`)
    );
  }

  const table = writeTable(out);
  if (!table) {
    (verb === 'INSERT' ? errors : warnings).push('Could not tell which table this statement writes; column checks were skipped.');
    return done();
  }

  let cols: ColumnInfo[];
  try {
    cols = await getTableColumns(ctx.client, ctx.target, table);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (verb === 'INSERT' ? errors : warnings).push(`Could not read the columns of ${table} (${msg}); nothing was checked against the schema.`);
    return finish();
  }
  const has = (name: string) => cols.some((c) => c.name.toLowerCase() === name.toLowerCase());

  if (verb === 'INSERT') {
    if (cols.length === 0) {
      errors.push(`Table ${table} was not found in the database.`);
      return done();
    }
    const parsed = parseInsert(out);
    if ('error' in parsed) {
      errors.push(parsed.error);
      return done();
    }
    const listed = new Set(parsed.columns.map((c) => c.toLowerCase()));

    for (const c of parsed.columns) {
      if (!has(c)) {
        errors.push(
          c.toLowerCase() === 'issystem'
            ? `${table} has no IsSystem column (IsSystem is declared per entity, not on every table). Remove it from the INSERT.`
            : `${table} has no column named ${c}.`
        );
      }
    }
    for (const row of parsed.rows) {
      if (row.length !== parsed.columns.length) {
        errors.push(`The INSERT lists ${parsed.columns.length} columns but a row supplies ${row.length} values.`);
        break;
      }
    }

    if (table.toLowerCase() === 'groupmember') {
      if (!listed.has('grouptypeid')) {
        errors.push(
          "GroupMember INSERT must set GroupTypeId (a copy of the group's GroupTypeId that raw SQL does not fill; read it from the group's own [Group].GroupTypeId)."
        );
      }
      if (!listed.has('datetimeadded')) {
        warnings.push(`GroupMember INSERT has no DateTimeAdded; consider ${now ?? 'setting it (set ROCK_TIMEZONE to get a ready-made "now" expression)'}.`);
      }
    }

    const autoFill = new Set(['createddatetime', 'modifieddatetime', 'createdbypersonaliasid', 'modifiedbypersonaliasid']);
    for (const c of cols) {
      const lc = c.name.toLowerCase();
      if (c.nullable || c.hasDefault || c.identity || c.computed || listed.has(lc) || autoFill.has(lc)) continue;
      if (lc === 'grouptypeid' && table.toLowerCase() === 'groupmember') continue; // reported above
      errors.push(`${table}.${c.name} is NOT NULL with no default and is missing from the INSERT.`);
    }

    // Additions: audit columns the table has and the INSERT leaves out.
    const additions: Array<{ col: string; expr: string }> = [];
    const needTime = ['CreatedDateTime', 'ModifiedDateTime'].filter((n) => has(n) && !listed.has(n.toLowerCase()));
    if (needTime.length && now) {
      for (const n of needTime) additions.push({ col: n, expr: now });
    } else if (needTime.length) {
      warnings.push(`${needTime.join(' and ')} left empty: ROCK_TIMEZONE is not set, so no "now" in Rock's time zone can be added. ${TIMEZONE_HELP}`);
    }
    const needAlias = ['CreatedByPersonAliasId', 'ModifiedByPersonAliasId'].filter((n) => has(n) && !listed.has(n.toLowerCase()));
    if (needAlias.length) {
      try {
        const me = await getKeyPerson(ctx.client, ctx.target);
        for (const n of needAlias) additions.push({ col: n, expr: String(me.aliasId) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`${needAlias.join(' and ')} left empty: could not look up the API key's person (${msg}).`);
      }
    }
    if (additions.length) {
      if (parsed.unsafeToRewrite) {
        warnings.push(
          `Not adding ${additions.map((a) => a.col).join(', ')}: the statement has a ${parsed.unsafeToRewrite}, so the INSERT was left as written. Add them yourself.`
        );
      } else if (errors.length === 0) {
        const colText = additions.map((a) => `[${a.col}], `).join('');
        const exprText = additions.map((a) => `${a.expr}, `).join('');
        const inserts = [{ at: parsed.columnListInsertAt, text: colText }, ...parsed.rowInsertAt.map((at) => ({ at, text: exprText }))];
        inserts.sort((a, b) => b.at - a.at);
        for (const ins of inserts) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
        for (const a of additions) warnings.push(`Added ${a.col} = ${a.expr}.`);
      }
    }
  } else if (verb === 'UPDATE') {
    if (cols.length === 0) {
      warnings.push(`Could not read columns for "${table}" (an alias or unknown table?); ModifiedDateTime/ModifiedByPersonAliasId were not checked.`);
    } else {
      const setAt = findTopLevelKeyword(masked, /^SET\b/i);
      const endAt = setAt >= 0 ? findTopLevelKeyword(masked, /^(FROM|WHERE|OUTPUT|OPTION)\b/i, setAt + 3) : -1;
      const setClause = setAt >= 0 ? masked.slice(setAt + 3, endAt >= 0 ? endAt : masked.length) : '';
      const assigned = new Set(
        splitTopLevel(setClause, setClause)
          .map((p) => p.text.split('=')[0])
          .map((lhs) => normalizeIdent(lhs))
      );
      for (const name of ['ModifiedDateTime', 'ModifiedByPersonAliasId']) {
        if (has(name) && !assigned.has(name.toLowerCase())) {
          warnings.push(
            name === 'ModifiedDateTime'
              ? `UPDATE does not set ModifiedDateTime; consider ModifiedDateTime = ${now ?? "Rock's \"now\" (set ROCK_TIMEZONE to get the expression)"}.`
              : "UPDATE does not set ModifiedByPersonAliasId; consider setting it to the API key person's primary alias."
          );
        }
      }
    }
  }

  return finish();

  function finish(): PreflightResult {
    // Belt and braces: whatever we return must still pass the existing write validator.
    const v = validateWrite(out, MODE_FOR_VERB[verb!]);
    if (!v.valid) errors.push(`SQL write rejected: ${v.error}`);
    return done();
  }
}
