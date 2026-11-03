// Pure-unit regression tests for P4 task 1 — flush_cache strict arg validation (no network).
// Covers the exact wrong-shape calls that used to reach `Math.trunc(undefined)` → NaN →
// `WHERE BlockId = NaN` (see reference/rock-sessions-lessons-2026-08-15.md L2).
// Run: node test/verify-flush-cache.mjs
import { validateFlushCacheParams, flushCache } from '../dist/tools/cache.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const throwsWith = async (name, fn, substr) => {
  try { await fn(); check(name, false); }
  catch (e) { check(name, String(e.message).includes(substr)); }
};

// --- validateFlushCacheParams: the exact bad shapes seen in transcripts (L2) ---
check('{} is rejected (missing target)', (() => {
  try { validateFlushCacheParams({}); return false; } catch (e) { return /invalid or missing "target"/.test(e.message); }
})());
check('{scope:"all"} is rejected', (() => {
  try { validateFlushCacheParams({ scope: 'all' }); return false; } catch (e) { return /invalid or missing "target"/.test(e.message); }
})());
check('{target:"all"} is rejected (not an enum value)', (() => {
  try { validateFlushCacheParams({ target: 'all' }); return false; } catch (e) { return /invalid or missing "target"/.test(e.message); }
})());
check('{cache_type, entity_id} is rejected (wrong param names)', (() => {
  try { validateFlushCacheParams({ cache_type: 'block', entity_id: 6076 }); return false; }
  catch (e) { return /invalid or missing "target"/.test(e.message); }
})());
check('{target:"block"} with no id is rejected', (() => {
  try { validateFlushCacheParams({ target: 'block' }); return false; } catch (e) { return /invalid or missing "id"/.test(e.message); }
})());
check('{target:"block", id:"6076"} (string id) is rejected', (() => {
  try { validateFlushCacheParams({ target: 'block', id: '6076' }); return false; } catch (e) { return /invalid or missing "id"/.test(e.message); }
})());
check('{target:"block", id: NaN} is rejected', (() => {
  try { validateFlushCacheParams({ target: 'block', id: NaN }); return false; } catch (e) { return /invalid or missing "id"/.test(e.message); }
})());
check('{target:"page", id:3519} is accepted', (() => {
  const r = validateFlushCacheParams({ target: 'page', id: 3519 });
  return r.target === 'page' && r.id === 3519;
})());
check('{target:"blocksettings", id:6418.7} truncates the id', (() => {
  const r = validateFlushCacheParams({ target: 'blocksettings', id: 6418.7 });
  return r.target === 'blocksettings' && r.id === 6418;
})());
check('{target:"pageroute", id:1} is rejected (not an enum value)', (() => {
  try { validateFlushCacheParams({ target: 'pageroute', id: 1 }); return false; } catch (e) { return /invalid or missing "target"/.test(e.message); }
})());
check('null params is rejected', (() => {
  try { validateFlushCacheParams(null); return false; } catch (e) { return /invalid or missing "target"/.test(e.message); }
})());
check('every rejection enumerates the valid shapes', (() => {
  try { validateFlushCacheParams({}); return false; } catch (e) { return e.message.includes('"htmlcontent"') && e.message.includes('"block"') && e.message.includes('"workflowtype"'); }
})());

// --- validateFlushCacheParams: valid shapes pass and truncate id ---
check('{target:"htmlcontent", id:123} is accepted', (() => {
  const r = validateFlushCacheParams({ target: 'htmlcontent', id: 123 });
  return r.target === 'htmlcontent' && r.id === 123;
})());
check('{target:"block", id:6076.9} truncates (not rounds) the id', (() => {
  const r = validateFlushCacheParams({ target: 'block', id: 6076.9 });
  return r.id === 6076;
})());
check('{target:"workflowtype", id:391} is accepted', (() => {
  const r = validateFlushCacheParams({ target: 'workflowtype', id: 391 });
  return r.target === 'workflowtype' && r.id === 391;
})());

// --- flushCache: the bad shapes must be rejected BEFORE any client call (never build the NaN SQL) ---
let clientCalls = 0;
const spyClient = {
  executeSql: async (sql) => { clientCalls++; return []; },
  v1Patch: async () => { clientCalls++; },
};
await throwsWith('flushCache rejects {} before touching the client', () => flushCache(spyClient, {}), 'invalid or missing "target"');
check('flushCache made zero client calls for {}', clientCalls === 0);

await throwsWith('flushCache rejects {cache_type, entity_id} before touching the client',
  () => flushCache(spyClient, { cache_type: 'block', entity_id: 6076 }), 'invalid or missing "target"');
check('flushCache made zero client calls for {cache_type, entity_id}', clientCalls === 0);

// The historical bug, proven fixed: a mis-shaped call must NEVER reach a SQL string
// containing "NaN".
let sqlSeen = null;
const nanSpyClient = { executeSql: async (sql) => { sqlSeen = sql; return []; }, v1Patch: async () => {} };
try { await flushCache(nanSpyClient, { cache_type: 'block', entity_id: 6076 }); } catch { /* expected to throw */ }
check('the historical WHERE BlockId = NaN query is never built', sqlSeen === null);

// --- flushCache: valid workflowtype shape still works end-to-end (regression guard) ---
let patchedPath = null, patchedBody = null;
const wfClient = { v1Patch: async (path, body) => { patchedPath = path; patchedBody = body; } };
const wfResult = await flushCache(wfClient, { target: 'workflowtype', id: 391 });
check('valid workflowtype call still PATCHes WorkflowTypes/<id>', patchedPath === 'WorkflowTypes/391');
check('valid workflowtype call still stamps ModifiedDateTime', typeof patchedBody.ModifiedDateTime === 'string');
check('valid workflowtype call reports flushed:true', wfResult.flushed === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
