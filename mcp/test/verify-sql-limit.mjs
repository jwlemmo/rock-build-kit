// Pure-unit regression tests for P4 task 2 — execute_sql's optional `limit` param (no network).
// Covers applyTopLimit's TOP-injection logic directly, plus executeSql's end-to-end wiring
// (limit omitted stays byte-for-byte backward compatible; limit applied/declined shapes).
// Run: node test/verify-sql-limit.mjs
import { applyTopLimit } from '../dist/sql-validator.js';
import { executeSql, withLimitNote } from '../dist/tools/sql.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const throwsWith = async (name, fn, substr) => {
  try { await fn(); check(name, false); }
  catch (e) { check(name, String(e.message).includes(substr)); }
};

// --- applyTopLimit: plain SELECT ---
{
  const r = applyTopLimit('SELECT Id, Name FROM Person', 25);
  check('plain SELECT: TOP injected right after SELECT', r.applied && r.sql === 'SELECT TOP 25 Id, Name FROM Person');
}
{
  const r = applyTopLimit('SELECT DISTINCT CampusId FROM Person', 10);
  check('SELECT DISTINCT: TOP injected after DISTINCT', r.applied && r.sql === 'SELECT DISTINCT TOP 10 CampusId FROM Person');
}
{
  const r = applyTopLimit('select id from person', 5);
  check('lowercase select: still matched and injected', r.applied && /select TOP 5 id/.test(r.sql));
}

// --- applyTopLimit: DECLARE/SET prologue is untouched, only the terminal SELECT gets TOP ---
{
  const r = applyTopLimit("DECLARE @x int = 5; SELECT Id FROM Person WHERE Age > @x", 50);
  check('DECLARE prologue preserved verbatim', r.applied && r.sql.startsWith('DECLARE @x int = 5; SELECT TOP 50 Id FROM Person'));
}

// --- applyTopLimit: CTE — only the OUTER select gets TOP, inner SELECT untouched ---
{
  const r = applyTopLimit('WITH cte AS (SELECT Id FROM Person WHERE IsActive = 1) SELECT Id FROM cte', 15);
  check('CTE: outer SELECT gets TOP, inner CTE body untouched',
    r.applied && r.sql === 'WITH cte AS (SELECT Id FROM Person WHERE IsActive = 1) SELECT TOP 15 Id FROM cte');
}

// --- applyTopLimit: subqueries never get matched (always inside parens → depth > 0) ---
{
  const r = applyTopLimit("SELECT Id FROM Person WHERE Id IN (SELECT PersonId FROM GroupMember)", 20);
  check('subquery in WHERE: only outer SELECT gets TOP', r.applied && r.sql.startsWith('SELECT TOP 20 Id FROM Person WHERE Id IN (SELECT PersonId FROM GroupMember)'));
}

// --- applyTopLimit: ORDER BY at the top level composes fine (the reason TOP was chosen over a wrapping subquery) ---
{
  const r = applyTopLimit('SELECT Id, LastName FROM Person ORDER BY LastName', 30);
  check('ORDER BY preserved and still valid (TOP + ORDER BY, no derived-table issue)', r.applied && r.sql === 'SELECT TOP 30 Id, LastName FROM Person ORDER BY LastName');
}

// --- applyTopLimit: declines safely rather than guessing wrong ---
{
  const r = applyTopLimit('SELECT TOP 5 Id FROM Person', 50);
  check('already-TOP query: declined, original SQL returned unchanged', !r.applied && r.sql === 'SELECT TOP 5 Id FROM Person');
  check('already-TOP query: reason explains why', /already declares an explicit TOP/.test(r.reason));
}
{
  const r = applyTopLimit('SELECT DISTINCT TOP 5 Id FROM Person', 50);
  check('already-TOP-after-DISTINCT query: declined', !r.applied);
}
{
  const r = applyTopLimit('SELECT Id FROM Person UNION SELECT Id FROM Group_Member', 10);
  check('UNION query: declined (would silently only cap the first branch)', !r.applied);
  check('UNION query: original SQL unchanged', r.sql === 'SELECT Id FROM Person UNION SELECT Id FROM Group_Member');
  check('UNION query: reason mentions UNION', /UNION/.test(r.reason));
}
{
  const r = applyTopLimit('SELECT Id FROM Person', 0);
  check('limit:0 is rejected (not a positive integer)', !r.applied && /positive integer/.test(r.reason));
}
{
  const r = applyTopLimit('SELECT Id FROM Person', -5);
  check('negative limit is rejected', !r.applied);
}

// --- applyTopLimit: comments and string literals don't confuse the scanner ---
{
  const r = applyTopLimit("SELECT Id FROM Person WHERE Note = 'a SELECT trap'", 5);
  check('a literal string containing the word SELECT is not mistaken for a keyword', r.applied && r.sql === "SELECT TOP 5 Id FROM Person WHERE Note = 'a SELECT trap'");
}
{
  const r = applyTopLimit("-- SELECT this is a comment\nSELECT Id FROM Person", 5);
  check('a SELECT inside a line comment is not mistaken for a keyword', r.applied && r.sql.includes('TOP 5 Id FROM Person') && !/-- SELECT TOP/.test(r.sql));
}

// --- withLimitNote: response-shape wrapping ---
{
  const w = withLimitNote([{ a: 1 }], { limitApplied: true });
  check('withLimitNote wraps an array result with rows + limitApplied', w.limitApplied === true && Array.isArray(w.rows) && w.rows.length === 1);
}
{
  const w = withLimitNote({ truncated: true, totalRows: 5000, rows: [] }, { limitApplied: false, limitReason: 'x' });
  check('withLimitNote merges into an existing truncated-wrapper object (not double-nested)', w.limitApplied === false && w.limitReason === 'x' && w.truncated === true);
}

// --- executeSql end-to-end: limit omitted → response shape is UNCHANGED (compatibility) ---
{
  const client = { executeSql: async () => [{ Id: 1 }, { Id: 2 }] };
  const result = await executeSql(client, { query: 'SELECT Id FROM Person' });
  check('limit omitted: result is the plain rows array, no wrapper', Array.isArray(result) && result.length === 2 && result[0].Id === 1);
}

// --- executeSql end-to-end: limit applied → query sent to the client actually carries TOP ---
{
  let sentQuery = null;
  const client = { executeSql: async (q) => { sentQuery = q; return [{ Id: 1 }]; } };
  const result = await executeSql(client, { query: 'SELECT Id FROM Person', limit: 10 });
  check('limit applied: TOP was injected into the query sent to Rock', sentQuery === 'SELECT TOP 10 Id FROM Person');
  check('limit applied: response wrapped with limitApplied:true + rows', result.limitApplied === true && Array.isArray(result.rows));
}

// --- executeSql end-to-end: limit declined (UNION) → query runs UNMODIFIED, caller is told why ---
{
  let sentQuery = null;
  const client = { executeSql: async (q) => { sentQuery = q; return [{ Id: 1 }]; } };
  const query = 'SELECT Id FROM Person UNION SELECT Id FROM Group_Member';
  const result = await executeSql(client, { query, limit: 10 });
  check('limit declined: original query still ran unmodified (not corrupted, not blocked)', sentQuery === query);
  check('limit declined: response says limitApplied:false with a reason', result.limitApplied === false && typeof result.limitReason === 'string');
}

// --- executeSql: invalid limit values are rejected before the query ever runs ---
let ranCount = 0;
const countingClient = { executeSql: async () => { ranCount++; return []; } };
await throwsWith('limit:0 is rejected pre-query', () => executeSql(countingClient, { query: 'SELECT 1', limit: 0 }), 'must be a positive number');
await throwsWith('limit:-1 is rejected pre-query', () => executeSql(countingClient, { query: 'SELECT 1', limit: -1 }), 'must be a positive number');
await throwsWith('limit:"10" (string) is rejected pre-query', () => executeSql(countingClient, { query: 'SELECT 1', limit: '10' }), 'must be a positive number');
check('none of the rejected-limit calls reached the client', ranCount === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
