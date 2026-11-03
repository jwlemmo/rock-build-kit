/**
 * Verb-aware SQL validator for the guarded write path (rock_create/edit/delete, mode:"sql").
 *
 * SELECT-only execute_sql is unaffected — it keeps calling validateSelectOnly() in
 * sql-validator.ts. This validator permits exactly ONE leading write keyword per mode and
 * blocks the same dangerous keywords/patterns for everyone (even admins): DDL, privilege,
 * server, bulk, and stored-proc operations. There is deliberately no flag that turns
 * execute_sql into a write path.
 */

import {
  DANGEROUS_PATTERNS,
  removeComments,
  normalizeWhitespace,
  hasMultipleStatements,
  type ValidationResult,
} from './sql-validator.js';

export type WriteMode = 'create' | 'edit' | 'delete';

const LEADING: Record<WriteMode, RegExp> = {
  create: /^INSERT\b/i,
  edit: /^UPDATE\b/i,
  delete: /^DELETE\b/i,
};

// Always blocked regardless of mode — schema/DDL, privilege, server, and bulk operations.
const ALWAYS_BLOCKED = [
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'GRANT',
  'REVOKE',
  'DENY',
  'MERGE',
  'BULK',
  'EXEC',
  'EXECUTE',
];

/**
 * Strip string literals so keywords inside *values* (e.g. an action named
 * 'Create Google Account') don't false-trip the keyword scan. Handles doubled-quote
 * escaping ('') the way T-SQL does.
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""');
}

export function validateWrite(sql: string, mode: WriteMode): ValidationResult {
  if (!sql || sql.trim().length === 0) {
    return { valid: false, error: 'Query cannot be empty' };
  }

  const cleaned = removeComments(sql);
  const normalized = normalizeWhitespace(cleaned);

  // One statement only — blocks `INSERT …; DROP TABLE …` style stacking.
  if (hasMultipleStatements(cleaned)) {
    return { valid: false, error: 'Multiple SQL statements are not allowed (one write per call).' };
  }

  // The statement must genuinely start with the verb this tool claims.
  if (!LEADING[mode].test(normalized)) {
    const kw = mode === 'create' ? 'INSERT' : mode.toUpperCase();
    return {
      valid: false,
      error: `rock_${mode} (mode:"sql") requires a single ${kw} statement (got: "${normalized.slice(0, 24)}…").`,
    };
  }

  // Keyword scan against the de-literalized text so legitimate values don't false-trip.
  const scan = stripStringLiterals(normalized).toUpperCase();
  for (const kw of ALWAYS_BLOCKED) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(scan)) {
      return { valid: false, error: `${kw} is never allowed through the MCP — blocked for all users.` };
    }
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(stripStringLiterals(cleaned))) {
      return { valid: false, error: `Dangerous SQL pattern detected: ${pattern.source}` };
    }
  }

  // Lava delimiters would break out of the {% sql statement:'command' %} wrapper.
  if (/\{\{|\}\}|\{%|%\}/.test(sql)) {
    return { valid: false, error: 'Query may not contain Lava delimiters ({{ }} or {% %}).' };
  }

  return { valid: true };
}
