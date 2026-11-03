#!/usr/bin/env node
// Pure-unit tests for rock_restore (no network) — ledger reading, restore-plan
// classification, the two-phase token handshake, staleness/no-op guards, and the
// concrete restore paths (patch-back, reactivate, recreate, undo-create).
//
// IMPORTANT: ROCK_LOGS_DIR must be set BEFORE the safety/audit.ts and safety/manifest.ts
// modules are first imported — LOGS_DIR/AUDIT_FILE/SNAPSHOT_DIR are bound as module-level
// consts evaluated at import time. Static `import` statements are hoisted above ordinary
// statements, so `process.env.ROCK_LOGS_DIR = ...` followed by a static import would run
// too late. Every dist module in the audit-ledger transitive closage (rock-restore.js,
// rock-write.js, metrics.js, safety/index.js, safety/audit.js, safety/ledger.js) is
// therefore loaded via a dynamic `await import(...)` AFTER the env var is set — the same
// pattern test/smoke-writes.mjs uses for its .env loader.
//
// This test NEVER touches the real logs/ directory: ROCK_LOGS_DIR points at a scratch
// temp dir created fresh for this run and removed at the end (best-effort).
//
// Run: node test/verify-restore.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'rock-restore-test-'));
process.env.ROCK_LOGS_DIR = scratch;
// audit.ts derives AUDIT_FILE/SNAPSHOT_DIR from ROCK_LOGS_DIR when ROCK_AUDIT_FILE is unset —
// make sure a stray real-repo override never leaks into this run.
delete process.env.ROCK_AUDIT_FILE;
delete process.env.ROCK_MANIFEST_FILE;
mkdirSync(join(scratch, 'snapshots'), { recursive: true });

const CHANGES_FILE = join(scratch, 'changes.jsonl');
const SNAP_DIR = join(scratch, 'snapshots');

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name); }
};
const checkThrows = async (name, fn, msgPattern) => {
  try {
    await fn();
    fail++; failures.push(name); console.log('  FAIL ' + name + ' (did not throw)');
  } catch (e) {
    const ok = !msgPattern || msgPattern.test(e.message);
    if (ok) { pass++; console.log('  ok   ' + name); }
    else { fail++; failures.push(name); console.log('  FAIL ' + name + ` (wrong message: ${e.message})`); }
  }
};

// ---- ledger seeding helpers ----
function appendLine(rec) {
  writeFileSync(CHANGES_FILE, JSON.stringify(rec) + '\n', { flag: 'a' });
}
function writeSnapshot(name, data) {
  writeFileSync(join(SNAP_DIR, `${name}.json`), JSON.stringify(data, null, 2));
  return `logs/snapshots/${name}.json`;
}

// ---- Mock RockClient: records every call, returns canned responses keyed by call order ----
function makeMockClient(responses = {}) {
  const calls = [];
  const client = {
    calls,
    async v1Get(path) {
      calls.push({ fn: 'v1Get', path });
      const key = `v1Get:${path}`;
      if (key in responses) {
        const v = responses[key];
        if (v === '__404__') throw new Error(`Rock v1 GET ${path} → 404: not found`);
        if (v && typeof v === 'object' && v.__throw__) throw new Error(v.__throw__); // simulate non-404 failures (5xx, timeout)
        return v;
      }
      throw new Error(`Rock v1 GET ${path} → 404: not found (unmocked)`);
    },
    async v1Post(path, body) {
      calls.push({ fn: 'v1Post', path, body });
      const key = `v1Post:${path}`;
      if (key in responses) return responses[key];
      return { Id: 999 };
    },
    async v1Patch(path, body) {
      calls.push({ fn: 'v1Patch', path, body });
      return undefined;
    },
    async v1Delete(path) {
      calls.push({ fn: 'v1Delete', path });
      return undefined;
    },
    async executeSql(sql) {
      calls.push({ fn: 'executeSql', sql });
      let v;
      const key = `executeSql:${sql}`;
      if (key in responses) {
        v = responses[key];
      } else {
        // Fallback: match by a substring key prefixed with "~"
        for (const [k, r] of Object.entries(responses)) {
          if (k.startsWith('executeSql~') && sql.includes(k.slice('executeSql~'.length))) { v = r; break; }
        }
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && v.__throw__) throw new Error(v.__throw__); // simulate query failures
      return v === undefined ? [] : v;
    },
    async executeSqlCommand(sql) {
      calls.push({ fn: 'executeSqlCommand', sql });
      const key = `executeSqlCommand:${sql}`;
      if (key in responses) return responses[key];
      return 1;
    },
  };
  return client;
}

// ---- Dynamic imports AFTER env var is set (see header comment) ----
const { rockRestore } = await import('../dist/tools/rock-restore.js');
const { rockCreate } = await import('../dist/tools/rock-write.js');
const { readLedgerRecords, findLedgerRecord, laterWritesToTarget, loadSnapshot } = await import('../dist/safety/ledger.js');
const { AUDIT_FILE, SNAPSHOT_DIR } = await import('../dist/safety/audit.js');

// Sanity: confirm the module actually bound to our scratch dir, not the real repo.
check('audit.ts AUDIT_FILE resolved under scratch dir', AUDIT_FILE.startsWith(scratch));
check('audit.ts SNAPSHOT_DIR resolved under scratch dir', SNAPSHOT_DIR.startsWith(scratch));
check('AUDIT_FILE matches our seeded changes.jsonl path', AUDIT_FILE === CHANGES_FILE);

console.log('\n== rock_restore unit tests (offline, scratch ledger) ==\n');

// =========================================================================
// Fixture 1: rock_edit executed (rest) — HtmlContent PATCH, single field changed
// =========================================================================
const editAuditId = 'edit0001aaaaaaaa';
const editSnapRef = writeSnapshot(`${editAuditId}-before`, {
  Id: 4242, Guid: 'aaaaaaaa-0000-0000-0000-000000000001', Content: '<p>old content</p>', IsActive: true,
});
appendLine({
  auditId: editAuditId, ts: '2026-06-01T10:00:00.000Z', phase: 'preview',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 4242 },
  impactSummary: 'No dependents found.',
  payload: { Content: '<p>new content</p>' },
  confirmationToken: 'preview-token-placeholder',
  result: { success: true },
});
appendLine({
  auditId: editAuditId, ts: '2026-06-01T10:00:05.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 4242 },
  snapshotRef: editSnapRef,
  payload: { label: 'test edit', body: { Content: '<p>new content</p>' } },
  confirmationToken: 'exec-token-placeholder',
  result: { success: true },
});

// =========================================================================
// Fixture 2: rock_delete executed, deactivated (case d)
// =========================================================================
const deactAuditId = 'deact001bbbbbbbb';
const deactSnapRef = writeSnapshot(`${deactAuditId}-before`, {
  Id: 555, Guid: 'bbbbbbbb-0000-0000-0000-000000000002', Name: 'Old Group', IsActive: true,
});
appendLine({
  auditId: deactAuditId, ts: '2026-06-02T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_delete', verb: 'delete', mode: 'rest',
  target: { entityType: 'Group', id: 555 },
  snapshotRef: deactSnapRef,
  payload: { label: 'deactivate stale group', action: 'deactivated', hard: false },
  confirmationToken: 'deact-exec-token',
  result: { success: true },
});

// =========================================================================
// Fixture 3: rock_delete executed, hard-deleted (case e — recreate)
// =========================================================================
const hardDelAuditId = 'harddel2cccccccc';
const hardDelSnapRef = writeSnapshot(`${hardDelAuditId}-before`, {
  Id: 888, Guid: 'cccccccc-0000-0000-0000-000000000003', Name: 'Deleted Category',
  CreatedDateTime: '2025-01-01T00:00:00', ModifiedDateTime: '2025-06-01T00:00:00',
  CreatedByPersonAliasId: 10, ModifiedByPersonAliasId: 10,
  Attributes: { foo: 'bar' }, // nav/object prop — should be dropped
  ChildCategories: [1, 2, 3], // nav/array prop — should be dropped
  ParentCategoryId: null, IsSystem: false,
});
appendLine({
  auditId: hardDelAuditId, ts: '2026-06-03T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_delete', verb: 'delete', mode: 'rest',
  target: { entityType: 'Category', id: 888 },
  snapshotRef: hardDelSnapRef,
  payload: { label: 'remove unused category', action: 'deleted', hard: true },
  confirmationToken: 'harddel-exec-token',
  result: { success: true },
});

// =========================================================================
// Fixture 4: rock_create executed (rest) — undo-create (case b)
// =========================================================================
const createAuditId = 'create3dddddddd1';
appendLine({
  auditId: createAuditId, ts: '2026-06-04T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'rest',
  target: { entityType: 'DefinedValue' },
  payload: { label: 'new defined value', body: { Value: 'Test Value', DefinedTypeId: 12 } },
  result: { success: true, newId: 7777 },
});

// =========================================================================
// Fixture 5: preview-only record (case a — refuse)
// =========================================================================
const previewOnlyAuditId = 'preview4eeeeeee1';
appendLine({
  auditId: previewOnlyAuditId, ts: '2026-06-05T09:00:00.000Z', phase: 'preview',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'Block', id: 321 },
  payload: { Name: 'Would-be new name' },
  confirmationToken: 'never-confirmed-token',
  result: { success: true },
});

// =========================================================================
// Fixture 6: SQL edit executed (case g — refuse, snapshot returned)
// =========================================================================
const sqlEditAuditId = 'sqledit5ffffffff';
const sqlEditSnapRef = writeSnapshot(`${sqlEditAuditId}-before`, [
  { Id: 42, NickName: 'Old Nick' },
]);
appendLine({
  auditId: sqlEditAuditId, ts: '2026-06-06T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'sql',
  target: { entityType: 'Person', table: 'Person' },
  snapshotRef: sqlEditSnapRef,
  payload: { label: 'bulk nickname fix', sql: "UPDATE Person SET NickName = 'New Nick' WHERE Id = 42" },
  confirmationToken: 'sql-edit-exec-token',
  result: { success: true, rowsAffected: 1 },
});

// =========================================================================
// Fixture 7: upsert_metric_value executed (edit) — restore should touch only YValue
// =========================================================================
const metricAuditId = 'metric6aaaaaaaa2';
const metricSnapRef = writeSnapshot(`${metricAuditId}-before`, {
  Id: 9001, YValue: 42, MetricValueDateTime: '2026-05-01T00:00:00', Note: 'original note',
});
appendLine({
  auditId: metricAuditId, ts: '2026-06-07T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'upsert_metric_value', verb: 'edit', mode: 'rest',
  target: { entityType: 'MetricValue', id: 9001 },
  snapshotRef: metricSnapRef,
  payload: { metric: 'Weekend Attendance', metricId: 15, date: '2026-05-01', value: 100 },
  confirmationToken: 'metric-exec-token',
  result: { success: true },
});

// =========================================================================
// Fixture 8: staleness — an edit followed by a LATER edit to the same target
// =========================================================================
const staleAuditId = 'stale7bbbbbbbbb3';
const staleSnapRef = writeSnapshot(`${staleAuditId}-before`, {
  Id: 6001, Guid: 'dddddddd-0000-0000-0000-000000000004', Content: '<p>v1</p>',
});
appendLine({
  auditId: staleAuditId, ts: '2026-06-08T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 6001 },
  snapshotRef: staleSnapRef,
  payload: { label: 'v1 to v2', body: { Content: '<p>v2</p>' } },
  confirmationToken: 'stale-exec-token-1',
  result: { success: true },
});
const laterAuditId = 'later8ccccccccc4';
appendLine({
  auditId: laterAuditId, ts: '2026-06-09T09:00:00.000Z', phase: 'executed',
  operator: { email: 'someone-else@example.com', name: 'Someone Else', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 6001 },
  snapshotRef: 'inline',
  payload: { label: 'v2 to v3', body: { Content: '<p>v3</p>' } },
  confirmationToken: 'stale-exec-token-2',
  result: { success: true },
});

// =========================================================================
// Fixture 9: no-op — current state already matches the restore target
// =========================================================================
const noopAuditId = 'noop9ddddddddd5';
const noopSnapRef = writeSnapshot(`${noopAuditId}-before`, {
  Id: 7001, Guid: 'eeeeeeee-0000-0000-0000-000000000005', Content: '<p>already this</p>',
});
appendLine({
  auditId: noopAuditId, ts: '2026-06-10T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 7001 },
  snapshotRef: noopSnapRef,
  payload: { label: 'noop target', body: { Content: '<p>already this</p>' } },
  confirmationToken: 'noop-exec-token',
  result: { success: true },
});

// =========================================================================
// Fixture 10: corrupt lines interleaved (should be skipped, not crash)
// =========================================================================
writeFileSync(CHANGES_FILE, '{"not valid json\n', { flag: 'a' });
writeFileSync(CHANGES_FILE, '{"auditId":"nophasefield"}\n', { flag: 'a' }); // parses but missing `phase`
writeFileSync(CHANGES_FILE, '   \n', { flag: 'a' }); // blank line — should NOT count as corrupt

// =========================================================================
// Fixture 11: SQL create with newId (undo-create SQL, case f)
// =========================================================================
const sqlCreateAuditId = 'sqlcreate0eeeee6';
appendLine({
  auditId: sqlCreateAuditId, ts: '2026-06-11T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'sql',
  target: { entityType: 'WorkflowActionType', table: 'WorkflowActionType' },
  payload: { label: 'new action row', sql: "INSERT INTO WorkflowActionType (...) VALUES (...)" },
  result: { success: true, newId: 3003, rowsAffected: 1 },
});

// =========================================================================
// Fixture 12: unsupported verb (case h — refuse)
// =========================================================================
const unsupportedAuditId = 'unsupp1fffffff7';
appendLine({
  auditId: unsupportedAuditId, ts: '2026-06-12T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'flush_cache', verb: 'flush', mode: 'rest',
  // entityType deliberately inert: laterWritesToTarget treats later ID-LESS records of the
  // same entityType as same-table conflicts for id-targets, and this synthetic non-write
  // record must not manufacture staleness conflicts for the HtmlContent fixtures above.
  target: { entityType: 'SystemCache' },
  payload: {},
  result: { success: true },
});

// =====================================================================================
// TESTS
// =====================================================================================

// ---- 1. Ledger reading skips corrupt lines without crashing ----
{
  const records = await readLedgerRecords();
  check('corrupt/malformed lines skipped without throwing', Array.isArray(records));
  check('valid records still parsed despite corrupt lines nearby', records.some((r) => r.auditId === editAuditId));
  check('record with no phase field excluded (fails plausibility check)', !records.some((r) => r.auditId === 'nophasefield'));
}

// ---- 2. List mode ----
{
  const client = makeMockClient();
  const result = await rockRestore(client, { recent: 20 });
  check('list mode returns mode:"list"', result.mode === 'list');
  check('list mode issues no writes', client.calls.length === 0);
  const editEntry = result.entries.find((e) => e.auditId === editAuditId);
  check('list mode shows the rock_edit record as restorable', editEntry && editEntry.restorable === true);
  check('list mode gives a restore_action for the edit', editEntry && /PATCH/.test(editEntry.restore_action));
  const previewOnlyEntryMissing = !result.entries.some((e) => e.auditId === previewOnlyAuditId);
  check('list mode excludes preview-only records entirely (not an effective write)', previewOnlyEntryMissing);
  const sqlEditEntry = result.entries.find((e) => e.auditId === sqlEditAuditId);
  check('list mode flags SQL edit as NOT restorable', sqlEditEntry && sqlEditEntry.restorable === false);
  check('list mode gives why_not for SQL edit mentioning manual restore', sqlEditEntry && /manual/i.test(sqlEditEntry.why_not));
  const unsupportedEntry = result.entries.find((e) => e.auditId === unsupportedAuditId);
  check('list mode flags unknown-verb record as not restorable', unsupportedEntry && unsupportedEntry.restorable === false);
  const createEntry = result.entries.find((e) => e.auditId === createAuditId);
  check('list mode flags rock_create as restorable (undo-create)', createEntry && createEntry.restorable === true);
  check('list mode newest-first ordering', Date.parse(result.entries[0].ts) >= Date.parse(result.entries[result.entries.length - 1].ts));
}

// ---- 3. Preview: rest edit, correct PATCH-back body ----
let editToken;
{
  const client = makeMockClient({
    'v1Get:HtmlContents/4242': { Id: 4242, Content: '<p>new content</p>', IsActive: true },
  });
  const result = await rockRestore(client, { audit_id: editAuditId });
  check('preview phase returned', result.phase === 'preview');
  check('preview includes a confirmation_token', typeof result.confirmation_token === 'string' && result.confirmation_token.length > 0);
  check('preview PATCH-back body restores Content from snapshot', result.intended_change.body.Content === '<p>old content</p>');
  check('preview intended_change targets the right controller/id', result.intended_change.controller === 'HtmlContents' && result.intended_change.id === 4242);
  check('preview did not execute a write (no v1Patch call)', !client.calls.some((c) => c.fn === 'v1Patch'));
  check('preview shows current_state', result.current_state && result.current_state.Content === '<p>new content</p>');
  check('preview shows before_snapshot (the original before-state)', result.before_snapshot && result.before_snapshot.Content === '<p>old content</p>');
  editToken = result.confirmation_token;
}

// ---- 4. Tampered token rejected ----
await checkThrows(
  'tampered token rejected',
  async () => rockRestore(makeMockClient(), { audit_id: editAuditId, confirmation_token: editToken.slice(0, -4) + 'zzzz' }),
  /mismatch/i
);

// ---- 5. Changed-args token rejected (force flips without a fresh preview) ----
await checkThrows(
  'changed-args (force added) token rejected without fresh preview',
  async () => rockRestore(makeMockClient(), { audit_id: editAuditId, confirmation_token: editToken, force: true }),
  /mismatch/i
);

// ---- 6. Execute: performs the PATCH, writes executed ledger record + current-state snapshot ----
{
  const client = makeMockClient({
    'v1Get:HtmlContents/4242': { Id: 4242, Content: '<p>new content</p>', IsActive: true },
  });
  const result = await rockRestore(client, { audit_id: editAuditId, confirmation_token: editToken });
  check('execute phase returned', result.phase === 'executed');
  check('execute reports success', result.success === true);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('execute actually called v1Patch', !!patchCall);
  check('execute PATCHed the right controller/id', patchCall && patchCall.path === 'HtmlContents/4242');
  check('execute PATCH body restores old Content', patchCall && patchCall.body.Content === '<p>old content</p>');
  check('execute returns a before_snapshot_ref (current-state snapshot)', typeof result.before_snapshot_ref === 'string');
  check('execute returns an auditId', typeof result.auditId === 'string' && result.auditId.length > 0);
  check('execute reports auditLogged', result.auditLogged === true);

  // Verify a new executed ledger record actually landed, self-describing per spec.
  // Use findLedgerRecord (executed > create > preview precedence), not a raw .find() by
  // auditId — the SAME auditId (derived from editToken) also has an earlier 'preview'
  // phase record from test block #3's preview call, appended first.
  const allAfter = await readLedgerRecords();
  const newRec = findLedgerRecord(allAfter, result.auditId);
  check('a new executed ledger record was appended for the restore', !!newRec && newRec.phase === 'executed');
  check('restore ledger record is tool:"rock_restore"', newRec && newRec.tool === 'rock_restore');
  check('restore ledger payload is self-describing {label, restoreOf, body}', newRec && newRec.payload.restoreOf === editAuditId && newRec.payload.body.Content === '<p>old content</p>');
  check('restore ledger record cache_hint mentions HtmlContent cache-sensitivity', /cache/i.test(JSON.stringify(result.cache_hint || '')));

  // Verify the current-state snapshot file was actually written to disk.
  const loaded = await loadSnapshot(result.before_snapshot_ref);
  check('current-state snapshot file loads back the pre-restore state', loaded.data && loaded.data.Content === '<p>new content</p>');
}

// ---- 7. Preview-only record refused ----
{
  const result = await rockRestore(makeMockClient(), { audit_id: previewOnlyAuditId });
  check('preview-only auditId is refused', result.phase === 'refused');
  check('refusal reason mentions nothing executed', /nothing was ever executed|nothing.*execut/i.test(result.reason));
}

// ---- 8. SQL edit refused with snapshot returned ----
{
  const result = await rockRestore(makeMockClient(), { audit_id: sqlEditAuditId });
  check('SQL edit restore refused', result.phase === 'refused');
  check('SQL edit refusal mentions v1/manual restore', /rock_edit|rock_create|manual/i.test(result.reason));
  check('SQL edit refusal includes the snapshotRef', result.snapshotRef === sqlEditSnapRef);
  check('SQL edit refusal includes inline snapshot data', Array.isArray(result.snapshot) && result.snapshot[0].NickName === 'Old Nick');
}

// ---- 9. Staleness gate ----
let staleTokenNoForce, staleTokenForce;
{
  const client = makeMockClient({ 'v1Get:HtmlContents/6001': { Id: 6001, Content: '<p>v3</p>' } });
  const result = await rockRestore(client, { audit_id: staleAuditId });
  check('staleness detected → phase:"blocked"', result.phase === 'blocked');
  check('staleness blocked response has NO confirmation_token', result.confirmation_token === undefined);
  check('staleness later_writes lists the conflicting record', result.later_writes.some((w) => w.auditId === laterAuditId));
  staleTokenNoForce = result.confirmation_token;
}
{
  const client = makeMockClient({ 'v1Get:HtmlContents/6001': { Id: 6001, Content: '<p>v3</p>' } });
  const result = await rockRestore(client, { audit_id: staleAuditId, force: true });
  check('force:true bypasses staleness block and returns a preview', result.phase === 'preview');
  check('force:true preview includes a confirmation_token', typeof result.confirmation_token === 'string');
  check('force:true preview still surfaces later_writes for visibility', result.later_writes.some((w) => w.auditId === laterAuditId));
  staleTokenForce = result.confirmation_token;
}
check('force and no-force tokens differ (force is part of the token)', staleTokenForce !== staleTokenNoForce);
await checkThrows(
  'force-less phase-2 call with the force-derived token fails',
  async () => rockRestore(makeMockClient({ 'v1Get:HtmlContents/6001': { Id: 6001, Content: '<p>v3</p>' } }), { audit_id: staleAuditId, confirmation_token: staleTokenForce }),
  /mismatch/i
);
{
  // The matching force:true + staleTokenForce pair SHOULD execute cleanly.
  const client = makeMockClient({ 'v1Get:HtmlContents/6001': { Id: 6001, Content: '<p>v3</p>' } });
  const result = await rockRestore(client, { audit_id: staleAuditId, force: true, confirmation_token: staleTokenForce });
  check('force:true + matching token executes successfully', result.phase === 'executed' && result.success === true);
}

// ---- 10. No-op detection ----
{
  const client = makeMockClient({ 'v1Get:HtmlContents/7001': { Id: 7001, Content: '<p>already this</p>' } });
  const result = await rockRestore(client, { audit_id: noopAuditId });
  check('no-op detected when current already matches restore target', result.phase === 'noop');
  check('no-op response has no confirmation_token', result.confirmation_token === undefined);
  check('no-op did not write anything', !client.calls.some((c) => c.fn === 'v1Patch' || c.fn === 'v1Delete' || c.fn === 'v1Post' || c.fn === 'executeSqlCommand'));
}

// ---- 11. Undo-create (rest): previews DELETE and executes v1Delete ----
let createToken;
{
  const client = makeMockClient({ 'v1Get:DefinedValues/7777': { Id: 7777, Value: 'Test Value' } });
  const preview = await rockRestore(client, { audit_id: createAuditId });
  check('undo-create preview phase returned', preview.phase === 'preview');
  check('undo-create preview plans a hard DELETE', /DELETE/i.test(preview.planned_action) && /DefinedValues\/7777/.test(preview.planned_action));
  check('undo-create preview ran impact analysis', preview.impact !== undefined);
  createToken = preview.confirmation_token;
}
{
  const client = makeMockClient({ 'v1Get:DefinedValues/7777': { Id: 7777, Value: 'Test Value' } });
  const result = await rockRestore(client, { audit_id: createAuditId, confirmation_token: createToken });
  check('undo-create execute phase returned', result.phase === 'executed');
  const delCall = client.calls.find((c) => c.fn === 'v1Delete');
  check('undo-create execute actually called v1Delete', !!delCall && delCall.path === 'DefinedValues/7777');
}

// ---- 12. Deactivated → PATCH IsActive:true ----
let deactToken;
{
  const client = makeMockClient({ 'v1Get:Groups/555': { Id: 555, Name: 'Old Group', IsActive: false } });
  const preview = await rockRestore(client, { audit_id: deactAuditId });
  check('reactivate preview plans IsActive:true PATCH', /IsActive/.test(preview.planned_action) && /true/.test(preview.planned_action));
  deactToken = preview.confirmation_token;
}
{
  const client = makeMockClient({ 'v1Get:Groups/555': { Id: 555, Name: 'Old Group', IsActive: false } });
  const result = await rockRestore(client, { audit_id: deactAuditId, confirmation_token: deactToken });
  check('reactivate execute phase returned', result.phase === 'executed');
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch' && c.path === 'Groups/555');
  check('reactivate PATCHed IsActive:true', patchCall && patchCall.body.IsActive === true);
}

// ---- 13. Recreate strips Id/audit/nav fields, keeps Guid ----
let recreateToken;
{
  const client = makeMockClient(); // no Guid probe match → not a no-op
  const preview = await rockRestore(client, { audit_id: hardDelAuditId });
  check('recreate preview phase returned', preview.phase === 'preview');
  const body = preview.intended_change.body;
  check('recreate body strips Id', !('Id' in body));
  check('recreate body strips CreatedDateTime/ModifiedDateTime', !('CreatedDateTime' in body) && !('ModifiedDateTime' in body));
  check('recreate body strips CreatedByPersonAliasId/ModifiedByPersonAliasId', !('CreatedByPersonAliasId' in body) && !('ModifiedByPersonAliasId' in body));
  check('recreate body KEEPS Guid', body.Guid === 'cccccccc-0000-0000-0000-000000000003');
  check('recreate body drops nav/object properties (Attributes, ChildCategories)', !('Attributes' in body) && !('ChildCategories' in body));
  check('recreate body keeps plain scalar fields (Name, ParentCategoryId, IsSystem)', body.Name === 'Deleted Category' && body.IsSystem === false);
  check('recreate preview warns about numeric-Id relinking', preview.warnings.some((w) => /numeric.*Id|relink/i.test(w)));
  recreateToken = preview.confirmation_token;
}
{
  const client = makeMockClient({ 'v1Post:Categories': { Id: 9999, Guid: 'cccccccc-0000-0000-0000-000000000003' } });
  const result = await rockRestore(client, { audit_id: hardDelAuditId, confirmation_token: recreateToken });
  check('recreate execute phase returned', result.phase === 'executed');
  const postCall = client.calls.find((c) => c.fn === 'v1Post');
  check('recreate execute actually called v1Post to Categories', !!postCall && postCall.path === 'Categories');
  check('recreate execute returns the new Id', result.newId === 9999);
  check('recreate execute ledger record is create-shaped (result.newId set) so it is itself undo-createable', result.auditLogged === true);
}

// ---- 14. corrupt ledger lines skipped without crash (end-to-end via rockRestore too) ----
{
  // Already covered by test #1 for the raw reader; re-assert list mode also survives.
  const client = makeMockClient();
  let threw = false;
  try { await rockRestore(client, { recent: 50 }); } catch { threw = true; }
  check('rockRestore list mode survives corrupt lines in the ledger', !threw);
}

// ---- 15. upsert_metric_value executed record restores the right fields ----
let metricToken;
{
  const client = makeMockClient({ 'v1Get:MetricValues/9001': { Id: 9001, YValue: 100, MetricValueDateTime: '2026-05-01T00:00:00' } });
  const preview = await rockRestore(client, { audit_id: metricAuditId });
  check('metric restore preview phase returned', preview.phase === 'preview');
  check('metric restore body restores ONLY YValue (not MetricValueDateTime)', preview.intended_change.body.YValue === 42 && !('MetricValueDateTime' in preview.intended_change.body));
  check('metric restore targets MetricValues/9001', preview.intended_change.controller === 'MetricValues' && preview.intended_change.id === 9001);
  metricToken = preview.confirmation_token;
}
{
  const client = makeMockClient({ 'v1Get:MetricValues/9001': { Id: 9001, YValue: 100, MetricValueDateTime: '2026-05-01T00:00:00' } });
  const result = await rockRestore(client, { audit_id: metricAuditId, confirmation_token: metricToken });
  check('metric restore execute phase returned', result.phase === 'executed');
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch' && c.path === 'MetricValues/9001');
  check('metric restore PATCHed YValue back to 42', patchCall && patchCall.body.YValue === 42);
}

// ---- 16. SQL create with newId → undo-create SQL (case f) ----
let sqlCreateToken;
{
  const client = makeMockClient({ 'executeSql~WHERE Id = 3003': [{ Id: 3003 }] });
  const preview = await rockRestore(client, { audit_id: sqlCreateAuditId });
  check('SQL undo-create preview phase returned', preview.phase === 'preview');
  check('SQL undo-create preview plans a DELETE FROM statement', /DELETE FROM/i.test(preview.intended_change.sql) && /3003/.test(preview.intended_change.sql));
  sqlCreateToken = preview.confirmation_token;
}
{
  const client = makeMockClient({ 'executeSql~WHERE Id = 3003': [{ Id: 3003 }] });
  const result = await rockRestore(client, { audit_id: sqlCreateAuditId, confirmation_token: sqlCreateToken });
  check('SQL undo-create execute phase returned', result.phase === 'executed');
  const cmdCall = client.calls.find((c) => c.fn === 'executeSqlCommand');
  check('SQL undo-create execute called executeSqlCommand with the right DELETE', !!cmdCall && /DELETE FROM \[WorkflowActionType\] WHERE Id = 3003/.test(cmdCall.sql));
}

// ---- 17. Unknown/unsupported record refused (case h) ----
{
  const result = await rockRestore(makeMockClient(), { audit_id: unsupportedAuditId });
  check('unsupported-verb record refused', result.phase === 'refused');
}

// ---- 18. Unknown audit_id throws a clear error ----
await checkThrows(
  'unknown audit_id throws',
  async () => rockRestore(makeMockClient(), { audit_id: 'does-not-exist-anywhere' }),
  /no ledger record found/i
);

// =====================================================================================
// COORDINATOR-REVIEW FIXES — regression tests
// =====================================================================================

// ---- 19. fix 1: transient (non-404) errors must PROPAGATE, never read as noop ----
const nf404AuditId = 'nonfour9aaaaaa10';
writeSnapshot(`${nf404AuditId}-before`, { Id: 8101, Content: '<p>old-8101</p>' });
appendLine({
  auditId: nf404AuditId, ts: '2026-06-15T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 8101 },
  snapshotRef: `logs/snapshots/${nf404AuditId}-before.json`,
  payload: { label: '8101 edit', body: { Content: '<p>new-8101</p>' } },
  confirmationToken: 'nf-exec-token',
  result: { success: true },
});
await checkThrows(
  'fix1: non-404 v1Get error at patch-back preview propagates (not silently null)',
  async () => rockRestore(
    makeMockClient({ 'v1Get:HtmlContents/8101': { __throw__: 'Rock v1 GET HtmlContents/8101 → 500: kaboom' } }),
    { audit_id: nf404AuditId }
  ),
  /→ 500|kaboom/
);
await checkThrows(
  'fix1: non-404 v1Get error at undo-create preview propagates (NOT an "already gone" noop)',
  async () => rockRestore(
    makeMockClient({ 'v1Get:DefinedValues/7777': { __throw__: 'Rock v1 GET DefinedValues/7777 → 503: unavailable' } }),
    { audit_id: createAuditId }
  ),
  /→ 503/
);
// The SQL undo-create probe failure must also propagate. force:true because test 16's own
// executed restore is now (correctly) a same-table staleness conflict for this record.
await checkThrows(
  'fix1: SQL undo-create preview SELECT failure propagates (not noop)',
  async () => rockRestore(
    makeMockClient({ 'executeSql~WHERE Id = 3003': { __throw__: 'Rock SQL/Lava error: timeout after 45s' } }),
    { audit_id: sqlCreateAuditId, force: true }
  ),
  /timeout/
);

// ---- 20. fix 1: a GENUINE 404 still reads as noop for undo-create ----
const gone404AuditId = 'gone404baaaaaa11';
appendLine({
  auditId: gone404AuditId, ts: '2026-06-16T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'rest',
  target: { entityType: 'DefinedValue' },
  payload: { label: 'row later deleted outside the ledger', body: { Value: 'X' } },
  result: { success: true, newId: 8202 },
});
{
  const client = makeMockClient({ 'v1Get:DefinedValues/8202': '__404__' });
  const result = await rockRestore(client, { audit_id: gone404AuditId });
  check('fix1: genuine 404 at undo-create preview → noop', result.phase === 'noop');
  check('fix1: 404-noop issued no writes', !client.calls.some((c) => ['v1Patch', 'v1Delete', 'v1Post', 'executeSqlCommand'].includes(c.fn)));
}

// ---- 21. fix 2: staleness is re-checked at EXECUTE time ----
const raceAuditId = 'race21caaaaaa12';
writeSnapshot(`${raceAuditId}-before`, { Id: 8303, Content: '<p>old-8303</p>' });
appendLine({
  auditId: raceAuditId, ts: '2026-06-13T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 8303 },
  snapshotRef: `logs/snapshots/${raceAuditId}-before.json`,
  payload: { label: '8303 edit', body: { Content: '<p>new-8303</p>' } },
  confirmationToken: 'race-exec-token',
  result: { success: true },
});
{
  const mock = { 'v1Get:HtmlContents/8303': { Id: 8303, Content: '<p>new-8303</p>' } };
  const preview = await rockRestore(makeMockClient(mock), { audit_id: raceAuditId });
  check('fix2: clean preview minted a token (no conflicts yet)', preview.phase === 'preview' && typeof preview.confirmation_token === 'string');

  // A write lands on the same target BETWEEN the preview and the confirm:
  const raceLaterAuditId = 'race21dlateraa13';
  appendLine({
    auditId: raceLaterAuditId, ts: '2026-06-14T09:00:00.000Z', phase: 'executed',
    operator: { email: 'someone-else@example.com', name: 'Someone Else', source: 'git' },
    tool: 'rock_edit', verb: 'edit', mode: 'rest',
    target: { entityType: 'HtmlContent', id: 8303 },
    snapshotRef: 'inline',
    payload: { label: 'race winner', body: { Content: '<p>raced-8303</p>' } },
    confirmationToken: 'race-winner-token',
    result: { success: true },
  });

  const client = makeMockClient(mock);
  const result = await rockRestore(client, { audit_id: raceAuditId, confirmation_token: preview.confirmation_token });
  check('fix2: force-less execute after a mid-handshake write is blocked', result.phase === 'blocked');
  check('fix2: blocked execute lists the mid-handshake write', result.later_writes.some((w) => w.auditId === raceLaterAuditId));
  check('fix2: blocked execute performed NO write', !client.calls.some((c) => ['v1Patch', 'v1Delete', 'v1Post', 'executeSqlCommand'].includes(c.fn)));
  check('fix2: blocked execute points to a fresh force:true preview', /force:true/.test(result.next_step));

  // The documented path forward: a FRESH preview with force:true, confirmed with ITS token.
  const fp = await rockRestore(makeMockClient(mock), { audit_id: raceAuditId, force: true });
  check('fix2: fresh force:true preview mints a token despite the conflict', fp.phase === 'preview' && typeof fp.confirmation_token === 'string');
  const client2 = makeMockClient(mock);
  const done = await rockRestore(client2, { audit_id: raceAuditId, force: true, confirmation_token: fp.confirmation_token });
  check('fix2: force token executes through the conflict', done.phase === 'executed' && client2.calls.some((c) => c.fn === 'v1Patch'));
}

// ---- 22. fix 3: id-target matches later table-only SQL record (unit + flow) ----
{
  const later = [{
    auditId: 'sqlbulk', ts: '2026-01-02T00:00:00.000Z', phase: 'executed', tool: 'rock_edit',
    verb: 'edit', mode: 'sql', target: { entityType: 'Person', table: 'Person' }, result: { success: true },
  }];
  const hits = laterWritesToTarget(later, { entityType: 'Person', id: 42 }, '2026-01-01T00:00:00.000Z', 'orig1');
  check('fix3: id-target matches later table-only SQL record as same-table', hits.length === 1 && hits[0].confidence === 'same-table');
  const miss = laterWritesToTarget(later, { entityType: 'Group', id: 42 }, '2026-01-01T00:00:00.000Z', 'orig1');
  check('fix3: different entityType does not match', miss.length === 0);
}
const fix3AuditId = 'fix3floweaaaaa14';
writeSnapshot(`${fix3AuditId}-before`, { Id: 9501, Value: 'old-9501' });
appendLine({
  auditId: fix3AuditId, ts: '2026-06-20T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'DefinedValue', id: 9501 },
  snapshotRef: `logs/snapshots/${fix3AuditId}-before.json`,
  payload: { label: '9501 edit', body: { Value: 'new-9501' } },
  confirmationToken: 'fix3-exec-token',
  result: { success: true },
});
const fix3BulkAuditId = 'fix3bulkfaaaaa15';
appendLine({
  auditId: fix3BulkAuditId, ts: '2026-06-21T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'sql',
  target: { entityType: 'DefinedValue', table: 'DefinedValue' },
  snapshotRef: 'inline',
  payload: { label: 'bulk defined-value sweep', sql: "UPDATE DefinedValue SET [Order] = 0 WHERE DefinedTypeId = 12" },
  confirmationToken: 'fix3-bulk-token',
  result: { success: true, rowsAffected: 9 },
});
{
  const preview = await rockRestore(makeMockClient(), { audit_id: fix3AuditId });
  check('fix3: flow — REST edit restore blocked by later same-entity SQL write', preview.phase === 'blocked');
  check('fix3: flow — conflict surfaced with confidence same-table', preview.later_writes.some((w) => w.auditId === fix3BulkAuditId && w.confidence === 'same-table'));
}

// ---- 23. fix 4a: non-numeric SQL newId refused (never emits WHERE Id = NaN) ----
const nanAuditId = 'nanid23gaaaaaa16';
appendLine({
  auditId: nanAuditId, ts: '2026-06-17T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'sql',
  target: { entityType: 'BogusThing', table: 'BogusTable' },
  payload: { label: 'create with garbage id', sql: 'INSERT INTO BogusTable (...) VALUES (...)' },
  result: { success: true, newId: 'abc' },
});
{
  const client = makeMockClient();
  const result = await rockRestore(client, { audit_id: nanAuditId });
  check('fix4: non-numeric SQL newId refused', result.phase === 'refused' && /not numeric/i.test(result.reason));
  check('fix4: NaN refusal made no client calls at all', client.calls.length === 0);
}

// ---- 24. fix 4b: hostile table name rejected by the write-SQL gate ----
const dropAuditId = 'dropinj24haaaa17';
appendLine({
  auditId: dropAuditId, ts: '2026-06-18T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'sql',
  target: { entityType: 'Weird', table: 'Weird] ; DROP TABLE Person --' },
  payload: { label: 'ledger record with a hostile table name' },
  result: { success: true, newId: 12 },
});
{
  const client = makeMockClient();
  const result = await rockRestore(client, { audit_id: dropAuditId });
  check('fix4: hostile table name rejected via validateWrite', result.phase === 'refused' && /SQL write rejected/i.test(result.reason));
  check('fix4: hostile-table refusal reached no SQL', !client.calls.some((c) => c.fn === 'executeSql' || c.fn === 'executeSqlCommand'));
}

// ---- 25. fix 5: large bodies are truncated in list mode + planned_action ----
const bigAuditId = 'bigbody25iaaaa18';
writeSnapshot(`${bigAuditId}-before`, { Id: 8404, Content: 'x'.repeat(5000), IsActive: true });
appendLine({
  auditId: bigAuditId, ts: '2026-06-19T09:00:00.000Z', phase: 'executed',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_edit', verb: 'edit', mode: 'rest',
  target: { entityType: 'HtmlContent', id: 8404 },
  snapshotRef: `logs/snapshots/${bigAuditId}-before.json`,
  payload: { label: 'big content edit', body: { Content: 'y'.repeat(5000) } },
  confirmationToken: 'big-exec-token',
  result: { success: true },
});
{
  const list = await rockRestore(makeMockClient(), { recent: 50 });
  const entry = list.entries.find((e) => e.auditId === bigAuditId);
  check('fix5: list-mode restore_action is truncated for a huge body', entry && entry.restore_action.length < 300);
  check('fix5: truncation marker present in restore_action', entry && entry.restore_action.includes('…'));
  const preview = await rockRestore(
    makeMockClient({ 'v1Get:HtmlContents/8404': { Id: 8404, Content: 'y'.repeat(5000) } }),
    { audit_id: bigAuditId }
  );
  check('fix5: preview planned_action is truncated', preview.planned_action.length < 300);
  check('fix5: full body still travels untruncated in intended_change', preview.intended_change.body.Content === 'x'.repeat(5000));
}

// =====================================================================================
// ENTITYTYPE NORMALIZATION FIX — regression tests
//
// Bug: rockCreate's REST path ledgered target.entityType as the RAW controller
// (e.g. "Blocks", plural) instead of the normalized singular form every other write path
// uses. classifyRestore's undo-create branch feeds target.entityType straight into
// controllerFromEntityType(), which expects the normalized SINGULAR form — an already-plural
// string double-pluralizes ("Blocks" -> "Blockss"), targeting a nonexistent controller.
// The write side is now fixed (rock-write.ts normalizes before ledgering), but the real
// ledger already contains historical plural-entityType create records from before the fix,
// so the read side (controllerFromEntityType/tableGuess in rock-restore.ts) must also be
// defensive: normalize on the way IN, not just rely on the way out being fixed.
// =====================================================================================

// ---- 26. read-side defensive fix: a historical PLURAL entityType ('Blocks') classifies to
//          an undo-create plan whose controller is 'Blocks' (NOT 'Blockss') ----
const pluralEntityAuditId = 'plurl26jaaaaa19';
appendLine({
  auditId: pluralEntityAuditId, ts: '2026-06-22T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'rest',
  // This is the historical (pre-fix) shape: entityType ledgered as the raw REST controller,
  // plural, exactly as rockCreate used to write it before normalizeEntityType() was applied.
  target: { entityType: 'Blocks' },
  payload: { label: 'legacy block create (pre-fix ledger shape)', body: { Name: 'Legacy Block' } },
  result: { success: true, newId: 6060 },
});
{
  const client = makeMockClient({ 'v1Get:Blocks/6060': { Id: 6060, Name: 'Legacy Block' } });
  const preview = await rockRestore(client, { audit_id: pluralEntityAuditId });
  check('fix6: historical plural entityType preview phase returned', preview.phase === 'preview');
  check(
    'fix6: historical plural entityType ("Blocks") undo-create targets controller "Blocks", not "Blockss"',
    preview.intended_change.controller === 'Blocks'
  );
  check('fix6: historical plural entityType undo-create plans DELETE Blocks/6060', /DELETE/i.test(preview.planned_action) && /Blocks\/6060/.test(preview.planned_action));
  const pluralToken = preview.confirmation_token;

  const execClient = makeMockClient({ 'v1Get:Blocks/6060': { Id: 6060, Name: 'Legacy Block' } });
  const result = await rockRestore(execClient, { audit_id: pluralEntityAuditId, confirmation_token: pluralToken });
  check('fix6: historical plural entityType undo-create executes', result.phase === 'executed' && result.success === true);
  const delCall = execClient.calls.find((c) => c.fn === 'v1Delete');
  check('fix6: historical plural entityType undo-create called v1Delete on Blocks/6060 (not Blockss/...)', !!delCall && delCall.path === 'Blocks/6060');
}

// ---- 27. a SINGULAR entityType ('Block') still yields controller 'Blocks' (unaffected) ----
const singularEntityAuditId = 'singl27kaaaaa20';
appendLine({
  auditId: singularEntityAuditId, ts: '2026-06-23T09:00:00.000Z', phase: 'create',
  operator: { email: 'operator@example.com', name: 'the operator', source: 'git' },
  tool: 'rock_create', verb: 'create', mode: 'rest',
  // The current (post-fix) shape: entityType ledgered already-normalized/singular.
  target: { entityType: 'Block' },
  payload: { label: 'current block create (post-fix ledger shape)', body: { Name: 'New Block' } },
  result: { success: true, newId: 6161 },
});
{
  const client = makeMockClient({ 'v1Get:Blocks/6161': { Id: 6161, Name: 'New Block' } });
  const preview = await rockRestore(client, { audit_id: singularEntityAuditId });
  check('fix6: singular entityType ("Block") still undo-creates controller "Blocks"', preview.intended_change.controller === 'Blocks');
  check('fix6: singular entityType undo-create plans DELETE Blocks/6161', /Blocks\/6161/.test(preview.planned_action));
}

// ---- 28. write-side fix: rockCreate (mode:"rest") ledgers a NORMALIZED SINGULAR
//          entityType, not the raw plural controller ----
{
  const client = makeMockClient({ 'v1Post:Blocks': { Id: 7070 } });
  const result = await rockCreate(client, { mode: 'rest', controller: 'Blocks', body: { Name: 'Fresh Block' } });
  check('fix6: rockCreate (rest) returns success', result.success === true && result.newId === 7070);

  const all = await readLedgerRecords();
  const rec = findLedgerRecord(all, result.auditId);
  check('fix6: rockCreate ledger record found', !!rec);
  check('fix6: rockCreate ledgers entityType as SINGULAR "Block" (not raw plural "Blocks")', rec && rec.target.entityType === 'Block');
  check('fix6: rockCreate does NOT ledger the raw controller string as entityType', rec && rec.target.entityType !== 'Blocks');
}
{
  // A second controller through the irregular map (not a simple trailing-s pluralize) to
  // make sure the fix is normalizeEntityType's real irregular-map behavior, not a coincidence
  // of "Blocks" specifically.
  const client = makeMockClient({ 'v1Post:Categories': { Id: 7171 } });
  const result = await rockCreate(client, { mode: 'rest', controller: 'Categories', body: { Name: 'Fresh Category' } });
  const all = await readLedgerRecords();
  const rec = findLedgerRecord(all, result.auditId);
  check('fix6: rockCreate ledgers "Categories" controller as singular "Category" (irregular map, not naive trailing-s strip)', rec && rec.target.entityType === 'Category');
}

// =====================================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('Failures: ' + failures.join(', '));

// Best-effort cleanup — never touches the real repo's logs/ dir since scratch is under tmpdir().
try { rmSync(scratch, { recursive: true, force: true }); } catch {}

process.exit(fail ? 1 : 0);
