// Pure-unit regression tests for the 7/7 post-push mining batch (no network, no ledger writes):
// MCP-8 execute_sql result cap + reserved-word hint, MCP-9 Metric impact handler,
// MCP-10 rock_create verifyByGuid pre-validation, MCP-11 get_person arg coercion.
// Run: node test/verify-mining-batch.mjs
import { executeSql, capResult } from '../dist/tools/sql.js';
import { rockCreate } from '../dist/tools/rock-write.js';
import { getPerson } from '../dist/tools/people.js';
import { runImpact } from '../dist/safety/index.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const throwsWith = async (name, fn, substr) => {
  try { await fn(); check(name, false); }
  catch (e) { check(name, String(e.message).includes(substr)); }
};

// --- MCP-8: capResult ---
const small = [{ a: 1 }, { a: 2 }];
check('capResult passes small results through untouched', capResult(small) === small);
check('capResult passes non-arrays through', capResult('scalar') === 'scalar');

const big = Array.from({ length: 5000 }, (_, i) => ({ Id: i, Name: 'x'.repeat(40) }));
const capped = capResult(big);
check('capResult truncates oversized results', capped.truncated === true);
check('capResult reports totalRows', capped.totalRows === 5000);
check('capResult keeps whole rows under the budget',
  capped.returnedRows === capped.rows.length && capped.rows.length > 0 && capped.rows.length < 5000);
check('capResult stays within ~40k chars AS SHIPPED (pretty-printed)', JSON.stringify(capped, null, 2).length <= 40_000);
check('capResult note suggests TOP N', /TOP N/.test(capped.note));

// --- MCP-8: error hints via executeSql with a throwing fake client ---
const throwingClient = (msg) => ({ executeSql: async () => { throw new Error(msg); } });
await throwsWith('reserved-keyword hint appended',
  () => executeSql(throwingClient("Rock SQL/Lava error: (Block: sql) Incorrect syntax near the keyword 'Order'."), { query: 'SELECT b.Order FROM Block b' }),
  'bracket it everywhere it appears as a column: [Order]');
await throwsWith('Lava-delimiter rejection teaches the CHAR() search pattern',
  () => executeSql({}, { query: "SELECT 1 FROM HtmlContent WHERE Content LIKE '%{% raw%'" }),
  'CHAR() concatenation');

// --- MCP-10: rock_create verifyByGuid pre-validation (write must NOT run) ---
const REAL_GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
let writeCalls = 0;
const guardClient = {
  executeSqlCommand: async () => { writeCalls++; return 1; },
  executeSql: async () => [],
};
await throwsWith('verifyByGuid that is not a GUID is rejected pre-write',
  () => rockCreate(guardClient, { mode: 'sql', sql: "INSERT INTO AttributeValue (Guid) VALUES (NEWID())", verifyByGuid: "'" }),
  'is not a GUID');
await throwsWith('verifyByGuid absent from the SQL text is rejected pre-write',
  () => rockCreate(guardClient, { mode: 'sql', sql: 'INSERT INTO AttributeValue (Guid) VALUES (NEWID())', verifyByGuid: REAL_GUID }),
  'does not appear as a literal');
check('pre-validation ran before any write', writeCalls === 0);

// verify SELECT failing AFTER the insert must say the write may have committed
const insertSql = `INSERT INTO AttributeValue (Guid) VALUES ('${REAL_GUID}')`;
await throwsWith('verify-SELECT error reports the INSERT already executed',
  () => rockCreate(
    { executeSqlCommand: async () => 1, executeSql: async () => { throw new Error('Conversion failed when converting from a character string to uniqueidentifier.'); } },
    { mode: 'sql', sql: insertSql, verifyByGuid: REAL_GUID }),
  'The row may already exist');
await throwsWith('empty verify result warns against blind retry',
  () => rockCreate(
    { executeSqlCommand: async () => 1, executeSql: async () => [] },
    { mode: 'sql', sql: insertSql, verifyByGuid: REAL_GUID }),
  'may have committed');

// --- MCP-11: get_person arg coercion ---
let gotPath = null;
const personClient = { v2Get: async (path) => { gotPath = path; return { id: 103429 }; } };
await getPerson(personClient, { personId: '103429' });
check('get_person accepts personId as a numeric string', gotPath === 'people/103429');
await getPerson(personClient, { id: 413233 });
check('get_person still accepts id as a number', gotPath === 'people/413233');
await throwsWith('get_person with no id fails with a clear message',
  () => getPerson(personClient, {}), 'numeric Person ID');
await throwsWith('get_person with a non-numeric id fails clearly',
  () => getPerson(personClient, { id: 'abc' }), 'numeric Person ID');

// --- MCP-9: Metric impact handler ---
const sqlSeen = [];
const metricClient = {
  executeSql: async (sql) => {
    sqlSeen.push(sql);
    if (/COUNT\(\*\)/.test(sql)) return [{ C: 7 }];
    if (/MetricPartition/.test(sql)) return [{ Id: 1, Label: 'Campus', EntityTypeId: 67 }];
    if (/HtmlContent/.test(sql)) return [{ HtmlContentId: 838, BlockId: 6076, Page: 'Example Campaign' }];
    return [];
  },
};
const impact = await runImpact(metricClient, { entityType: 'Metric', id: 126, guid: REAL_GUID });
check('Metric impact analysis runs (no more "review manually")', impact.ran === true);
check('Metric impact counts MetricValues', impact.references.some((r) => r.kind === 'MetricValue' && r.count === 7));
check('Metric impact lists partitions', impact.references.some((r) => r.kind === 'MetricPartition'));
check('Metric impact finds dashboard content', impact.references.some((r) => r.kind === 'DashboardContent'));
check('Metric impact searches by guid when available', sqlSeen.some((s) => s.includes(REAL_GUID)));
check('unknown entity types still fall back to manual review',
  (await runImpact(metricClient, { entityType: 'MetricValuePartition' })).ran === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
