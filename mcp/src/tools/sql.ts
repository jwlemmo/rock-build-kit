/**
 * SQL Execution Tool for Rock RMS
 */

import { RockClient } from '../rock-client.js';
import { validateSelectOnly, applyTopLimit } from '../sql-validator.js';

export interface ExecuteSqlParams {
  query: string;
  limit?: number;
}

export const executeSqlSchema = {
  name: 'execute_sql',
  description:
    'Execute a read-only SQL SELECT query against the Rock RMS database. Runs server-side ' +
    'through Rock\'s Lava engine (a {% sql %} block via /api/Lava/RenderTemplate); results are ' +
    'returned as an array of row objects. Only SELECT statements are allowed — INSERT/UPDATE/' +
    'DELETE and other write/DDL keywords are rejected. A DECLARE/SET prologue before the final ' +
    'SELECT is fine; leading "--" comments are stripped safely. Inline literal values directly; ' +
    'bound parameters are not supported on this path. Unsure of a table\'s columns? call ' +
    'get_schema("TableName") first instead of guessing. Large results are truncated (~40k chars) ' +
    'with a row count regardless of limit — use SELECT TOP N, fewer columns, or server-side ' +
    'aggregates for big sets. Optional limit: pass a positive integer to cap row count instead of ' +
    'hand-writing "TOP N" yourself — it is injected into the outermost SELECT (works with or ' +
    'without an existing ORDER BY). Unlimited stays the default when limit is omitted (unchanged, ' +
    'backward-compatible response shape). limit is declined (query still runs, unlimited) rather ' +
    'than guessed wrong when the query already has an explicit TOP, or has more than one top-level ' +
    'SELECT (e.g. UNION) — in that case the response is wrapped with limitApplied:false and ' +
    'limitReason explaining why; write TOP into the query yourself for those shapes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The SQL SELECT query to execute (inline any literal values)',
      },
      limit: {
        type: 'number',
        description:
          'Optional: cap the row count by injecting TOP <limit> into the outermost SELECT. ' +
          'Omit for unlimited (default, unchanged behavior). Declined — not silently ignored — ' +
          'for queries that already have an explicit TOP or have multiple top-level SELECTs ' +
          '(UNION/INTERSECT/EXCEPT); the response then carries limitApplied:false + limitReason.',
      },
    },
    required: ['query'],
  },
};

export async function executeSql(client: RockClient, params: ExecuteSqlParams): Promise<unknown> {
  // Validate the query is SELECT-only
  const validation = validateSelectOnly(params.query);

  if (!validation.valid) {
    throw new Error(`SQL validation failed: ${validation.error}`);
  }

  // The query is embedded in a Lava {% sql %} block, so Lava delimiters would break out
  // of (or corrupt) the wrapper. Legitimate SELECT statements never contain these.
  if (/\{\{|\}\}|\{%|%\}/.test(params.query)) {
    throw new Error(
      'SQL validation failed: query may not contain Lava delimiters ({{ }} or {% %}). ' +
        'To inspect a row whose stored content contains Lava (HtmlContent, block settings), ' +
        'select a different column or use a REST get_* tool rather than reading it through {% sql %}. ' +
        'To SEARCH stored content for Lava delimiters, build the pattern with CHAR() concatenation ' +
        "instead of literals: DECLARE @tag nvarchar(10) = CHAR(123)+CHAR(37); ... WHERE Content LIKE '%'+@tag+'%'."
    );
  }

  let queryToRun = params.query;
  let limitNote: { limitApplied: boolean; limitReason?: string } | undefined;
  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number' || !Number.isFinite(params.limit) || params.limit <= 0) {
      throw new Error(
        `execute_sql: "limit" must be a positive number (got ${JSON.stringify(params.limit)}).`
      );
    }
    const injected = applyTopLimit(params.query, params.limit);
    if (injected.applied) {
      queryToRun = injected.sql;
      limitNote = { limitApplied: true };
    } else {
      limitNote = { limitApplied: false, limitReason: injected.reason };
    }
  }

  // Execute the query (rendered via Lava server-side), translating known Rock/Lava errors
  // into actionable hints on the way out.
  try {
    const result = capResult(await client.executeSql(queryToRun));
    return limitNote ? withLimitNote(result, limitNote) : result;
  } catch (err) {
    throw new Error(translateSqlError(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Merge the limit-application outcome into the tool result — ONLY called when `limit` was
 * explicitly passed, so a caller who never asks for limit sees the exact same response shape
 * as before (unlimited stays the default for compatibility). Arrays get wrapped as
 * { limitApplied, limitReason?, rows }; the capResult truncation-wrapper object gets the same
 * two fields merged in alongside its existing truncated/totalRows/rows fields.
 */
export function withLimitNote(
  result: unknown,
  note: { limitApplied: boolean; limitReason?: string }
): unknown {
  if (Array.isArray(result)) {
    return { ...note, rows: result };
  }
  if (result && typeof result === 'object') {
    return { ...note, ...(result as Record<string, unknown>) };
  }
  return result;
}

// Rock happily returns 30k+ rows through the Lava path; anything past this budget just
// overflows the MCP tool-output ceiling and reaches nobody. The budget is measured against
// the PRETTY-PRINTED form (JSON.stringify(..., null, 2)) because that is what the server
// actually ships in the tool result — compact-measuring under-counts by ~1.6x.
const MAX_RESULT_CHARS = Number(process.env.ROCK_SQL_MAX_RESULT_CHARS ?? 40_000);

/** Cap oversized result sets: keep whole rows up to the char budget, report what was cut. */
export function capResult(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  const full = JSON.stringify(rows, null, 2);
  if (full.length <= MAX_RESULT_CHARS) return rows;
  const kept: unknown[] = [];
  let used = 400; // envelope: the truncation-metadata fields around `rows`
  for (const row of rows) {
    const p = JSON.stringify(row, null, 2);
    // inside the wrapper the row sits two levels deep → every line gains 4 indent chars
    const len = p.length + p.split('\n').length * 4 + 2;
    if (used + len > MAX_RESULT_CHARS) break;
    kept.push(row);
    used += len;
  }
  const wrap = () => ({
    truncated: true,
    totalRows: rows.length,
    returnedRows: kept.length,
    note:
      `Result was ${full.length.toLocaleString()} chars across ${rows.length.toLocaleString()} rows — ` +
      `truncated to the first ${kept.length} rows to fit the tool output budget. ` +
      'Narrow the query (SELECT TOP N, fewer columns, WHERE filters, or aggregate server-side) to get the rest.',
    rows: kept,
  });
  // Exact final check against the shipped serialization; the estimate above lands close,
  // so this trims at most a handful of rows.
  let out = wrap();
  while (kept.length && JSON.stringify(out, null, 2).length > MAX_RESULT_CHARS) {
    kept.pop();
    out = wrap();
  }
  return out;
}

/** Append an actionable hint to the common, opaque Rock/Lava SQL error strings. */
function translateSqlError(msg: string): string {
  const badCol = msg.match(/Invalid column name '([^']+)'/i);
  if (badCol) {
    return `${msg}\nHint: column "${badCol[1]}" does not exist on that table — call get_schema("<table>") to list valid columns instead of guessing.`;
  }
  if (/Cannot find table 0/i.test(msg)) {
    return `${msg}\nHint: the query parsed as empty — check that it begins with SELECT/WITH (a stray leading comment used to cause this and is now stripped automatically).`;
  }
  if (/Timeout Expired/i.test(msg)) {
    return `${msg}\nHint: the query hit the server-side command timeout — add WHERE filters, aggregate server-side, or narrow the row set.`;
  }
  const ambiguous = msg.match(/Ambiguous column name '([^']+)'/i);
  if (ambiguous) {
    return `${msg}\nHint: column "${ambiguous[1]}" is ambiguous — qualify it with its table alias (e.g. p.${ambiguous[1]}).`;
  }
  const keyword = msg.match(/Incorrect syntax near the keyword '([^']+)'/i);
  if (keyword) {
    return `${msg}\nHint: "${keyword[1]}" is a reserved T-SQL keyword — Rock has literal columns named Order, Group, etc.; bracket it everywhere it appears as a column: [${keyword[1]}].`;
  }
  return msg;
}
