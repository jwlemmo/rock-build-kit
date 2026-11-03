/**
 * SQL Validator for Rock RMS ExecuteSql
 * Ensures only SELECT queries are allowed
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Keywords that indicate data modification or dangerous operations
const DANGEROUS_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'DENY',
  'MERGE',
  'BULK',
];

// Dangerous stored procedure prefixes and functions.
// Exported so the verb-aware write validator (sql-write-validator.ts) reuses the exact
// same always-blocked set rather than duplicating it.
export const DANGEROUS_PATTERNS = [
  /\bxp_\w+/i,           // Extended stored procedures
  /\bsp_\w+/i,           // System stored procedures
  /\bOPENROWSET\b/i,     // Remote data access
  /\bOPENQUERY\b/i,      // Linked server queries
  /\bOPENDATASOURCE\b/i, // Ad-hoc connections
  /\bOPENXML\b/i,        // XML processing with security implications
  /\bDBCC\b/i,           // Database console commands
  /\bSHUTDOWN\b/i,       // Server shutdown
  /\bRECONFIGURE\b/i,    // Server configuration
  /\bBACKUP\b/i,         // Backup operations
  /\bRESTORE\b/i,        // Restore operations
];

/**
 * Remove SQL comments from a query — literal-aware.
 *
 * A naive regex strip corrupts `--`/`/* *​/` sequences that appear INSIDE string or
 * bracketed-identifier literals (e.g. `WHERE Note = 'a -- b'`). This walks the string,
 * skipping `'...'`, `"..."`, and `[...]` literals (honoring doubled-delimiter escapes),
 * and removes only real comments. Line comments collapse to a newline (so the tokens on
 * either side don't merge); block comments collapse to a space.
 */
export function removeComments(sql: string): string {
  let out = '';
  let quote: string | null = null; // closing delimiter we're waiting for: ' " or ]
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const n = i + 1 < sql.length ? sql[i + 1] : '';
    if (quote) {
      out += c;
      if (c === quote) {
        if (n === quote) { out += n; i++; }   // doubled delimiter = escaped literal
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '[') { quote = c === '[' ? ']' : c; out += c; continue; }
    if (c === '-' && n === '-') {             // line comment → skip to EOL, keep the newline
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {             // block comment → skip to */
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 1;                                 // land on '/', loop's i++ moves past it
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Normalize whitespace in query
 */
export function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Check if query contains multiple statements
 */
export function hasMultipleStatements(sql: string): boolean {
  // Remove string literals to avoid false positives
  const withoutStrings = sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');

  // Count semicolons - allow trailing semicolon but not multiple statements
  const semicolons = (withoutStrings.match(/;/g) || []).length;

  // Check if there's content after a semicolon (indicating multiple statements)
  const afterSemicolon = withoutStrings.split(';').slice(1).join('').trim();

  return semicolons > 1 || (semicolons === 1 && afterSemicolon.length > 0);
}

/**
 * Check if query starts with SELECT (accounting for CTEs)
 */
function startsWithSelect(sql: string): boolean {
  const normalized = normalizeWhitespace(removeComments(sql)).toUpperCase();

  // Direct SELECT
  if (normalized.startsWith('SELECT ') || normalized.startsWith('SELECT\t')) {
    return true;
  }

  // CTE (WITH ... AS ... SELECT)
  if (normalized.startsWith('WITH ')) {
    // Find the main query after CTEs
    // CTEs end with closing paren followed by SELECT or comma for another CTE
    const mainQueryMatch = normalized.match(/\)\s*SELECT\s/);
    return mainQueryMatch !== null;
  }

  return false;
}

/**
 * Split SQL into statements on semicolons that sit OUTSIDE string/identifier literals.
 * Trims and drops empty segments (so leading/trailing semicolons don't create phantom
 * statements).
 */
function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const n = i + 1 < sql.length ? sql[i + 1] : '';
    if (quote) {
      cur += c;
      if (c === quote) {
        if (n === quote) { cur += n; i++; }
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '[') { quote = c === '[' ? ']' : c; cur += c; continue; }
    if (c === ';') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Validate that a query is read-only.
 *
 * Data-modifying / dangerous keywords are rejected anywhere in the query — this is the real
 * security backstop and it catches a write even if smuggled inside a multi-statement batch.
 * On top of that, the statement SHAPE is checked leniently for the read path: a DECLARE/SET
 * prologue (and a leading `;WITH`) may precede a single terminal SELECT/WITH. This deliberately
 * allows the legitimate `;WITH …`, `DECLARE @x …; SELECT …` patterns that the stricter
 * hasMultipleStatements() (still used by the WRITE validator) would false-positive on, while
 * still rejecting two independent SELECTs (which would return an ambiguous single result set).
 */
export function validateSelectOnly(sql: string): ValidationResult {
  if (!sql || sql.trim().length === 0) {
    return { valid: false, error: 'Query cannot be empty' };
  }

  const cleanedSql = removeComments(sql);
  const normalizedSql = normalizeWhitespace(cleanedSql).toUpperCase();

  // Dangerous keywords anywhere → reject (security backstop).
  for (const keyword of DANGEROUS_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(normalizedSql)) {
      return {
        valid: false,
        error: `${keyword} statements are not allowed. execute_sql is read-only — for writes use rock_create/rock_edit/rock_delete with mode:"sql".`,
      };
    }
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cleanedSql)) {
      return { valid: false, error: `Dangerous SQL pattern detected: ${pattern.source}` };
    }
  }

  // Statement-shape check (read path).
  const statements = splitStatements(cleanedSql);
  if (statements.length === 0) {
    return { valid: false, error: 'Query cannot be empty' };
  }
  const terminal = statements[statements.length - 1];
  if (!startsWithSelect(terminal)) {
    return { valid: false, error: 'Query must end with a SELECT (or WITH … SELECT).' };
  }
  for (const stmt of statements.slice(0, -1)) {
    if (!/^\s*(DECLARE|SET)\b/i.test(stmt)) {
      return {
        valid: false,
        error: 'Multiple statements are not allowed (only a DECLARE/SET prologue may precede the final SELECT).',
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------------------
// TOP-limit injection — backs execute_sql's optional `limit` param.
// ---------------------------------------------------------------------------------------

export interface TopInjectionResult {
  sql: string;
  applied: boolean;
  reason?: string;
}

/**
 * Insert `TOP <n>` into the outermost SELECT of a query for execute_sql's optional `limit`
 * param. Only meaningful to call after validateSelectOnly has already confirmed the query's
 * shape (an optional DECLARE/SET prologue followed by exactly one terminal SELECT, or a
 * WITH…SELECT). TOP (not a wrapping subquery, not OFFSET/FETCH) is the only SQL Server
 * limiting clause that composes safely with an existing ORDER BY without extra rewriting —
 * OFFSET/FETCH requires an ORDER BY that may not exist, and wrapping the query as
 * `SELECT TOP n * FROM (<query>) t` breaks the moment the inner query has its own ORDER BY
 * (invalid in a derived table without its own TOP/OFFSET).
 *
 * A single left-to-right scan tracks quote/bracket literals, line/block comments, and paren
 * depth. Only SELECT keywords at paren-depth-0 *within the terminal statement* are candidate
 * injection points — this naturally skips SELECTs inside CTE bodies and subqueries (they're
 * always inside at least one paren) without any CTE-specific casing.
 *
 * Declines (returns the ORIGINAL sql unchanged, applied:false, with a reason) rather than
 * guessing when:
 *   - the terminal statement has more than one top-level SELECT (UNION/UNION ALL/INTERSECT/
 *     EXCEPT) — injecting TOP into only the first branch would silently change the query's
 *     meaning instead of capping the total row count;
 *   - the located SELECT already declares an explicit TOP (avoid "SELECT TOP 5 TOP 50 …");
 *   - no top-level SELECT can be found at all (defensive fallback).
 * Declining is always safe: the caller falls back to running the query unlimited, which is
 * the pre-existing behavior — this can only ever narrow a result set, never corrupt one.
 */
export function applyTopLimit(sql: string, limit: number): TopInjectionResult {
  const n = Math.trunc(limit);
  if (!Number.isFinite(n) || n <= 0) {
    return { sql, applied: false, reason: `limit must be a positive integer (got ${JSON.stringify(limit)})` };
  }

  // Pass 1: find the terminal statement's start — the character right after the last
  // top-level (depth-0, outside quotes/comments) semicolon, mirroring splitStatements()'s
  // shape rules but keeping an offset into the ORIGINAL string instead of extracting a
  // comment-stripped substring (we need to edit the original text in place).
  const terminalStart = findTerminalStatementStart(sql);

  // Pass 2: within the terminal statement, find every depth-0 SELECT keyword.
  const selectPositions = findTopLevelSelects(sql, terminalStart);

  if (selectPositions.length === 0) {
    return { sql, applied: false, reason: 'could not locate a top-level SELECT in the terminal statement' };
  }
  if (selectPositions.length > 1) {
    return {
      sql,
      applied: false,
      reason:
        'terminal statement has more than one top-level SELECT (e.g. UNION/UNION ALL/INTERSECT/' +
        'EXCEPT) — automatic TOP injection is not supported for this shape; add TOP directly to ' +
        'the query instead',
    };
  }

  const selectStart = selectPositions[0];
  const afterSelect = selectStart + 'SELECT'.length;
  const skipWs = (pos: number): number => {
    let p = pos;
    while (p < sql.length && /\s/.test(sql[p])) p++;
    return p;
  };

  const afterSelectWs = skipWs(afterSelect);
  const tailUpper = sql.slice(afterSelectWs).toUpperCase();

  if (/^TOP\b/.test(tailUpper)) {
    return { sql, applied: false, reason: 'terminal SELECT already declares an explicit TOP — limit not applied' };
  }

  let insertAt = afterSelect; // default: right after "SELECT"
  const distinctMatch = /^(DISTINCT|ALL)\b/.exec(tailUpper);
  if (distinctMatch) {
    insertAt = afterSelectWs + distinctMatch[1].length;
    const afterModifierWs = skipWs(insertAt);
    if (/^TOP\b/i.test(sql.slice(afterModifierWs))) {
      return { sql, applied: false, reason: 'terminal SELECT already declares an explicit TOP — limit not applied' };
    }
  }

  const out = sql.slice(0, insertAt) + ` TOP ${n}` + sql.slice(insertAt);
  return { sql: out, applied: true };
}

/** Offset of the first character after the last top-level (depth-0, unquoted) semicolon. */
function findTerminalStatementStart(sql: string): number {
  let quote: string | null = null;
  let depth = 0;
  let lastTopLevelSemicolon = -1;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const nextC = i + 1 < sql.length ? sql[i + 1] : '';
    if (quote) {
      if (c === quote) {
        if (nextC === quote) { i++; } else { quote = null; }
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '[') { quote = c === '[' ? ']' : c; continue; }
    if (c === '-' && nextC === '-') { i += 2; while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && nextC === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (c === ';' && depth === 0) { lastTopLevelSemicolon = i; continue; }
  }
  return lastTopLevelSemicolon + 1;
}

/** Offsets of every SELECT keyword at paren-depth 0 within sql, scanning from `from`. */
function findTopLevelSelects(sql: string, from: number): number[] {
  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  let quote: string | null = null;
  let depth = 0;
  const positions: number[] = [];
  for (let i = from; i < sql.length; i++) {
    const c = sql[i];
    const nextC = i + 1 < sql.length ? sql[i + 1] : '';
    if (quote) {
      if (c === quote) {
        if (nextC === quote) { i++; } else { quote = null; }
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '[') { quote = c === '[' ? ']' : c; continue; }
    if (c === '-' && nextC === '-') { i += 2; while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && nextC === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && (c === 'S' || c === 's') && sql.slice(i, i + 6).toUpperCase() === 'SELECT') {
      const before = i === 0 ? ' ' : sql[i - 1];
      const after = i + 6 < sql.length ? sql[i + 6] : ' ';
      if (!isWordChar(before) && !isWordChar(after)) {
        positions.push(i);
      }
    }
  }
  return positions;
}
