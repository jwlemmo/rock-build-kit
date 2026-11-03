#!/usr/bin/env node
// Pure-unit tests for src/buildlib/ (no network) — dry-run-by-default gate, create()/patch()/
// ensure()/findByForeignKey()/upsertAttributeValue()/touchAndFlush()/updateBlockContent()/
// lockToGroups()/widenAccess()/createWorkflowAction() ledger shapes, parseBuildArgs, localISO,
// and restore-compat against rock-restore's classifyRestore (the ARC-3 acceptance bar).
//
// IMPORTANT: ROCK_LOGS_DIR must be set BEFORE the safety/audit.ts and safety/manifest.ts
// modules are first imported — LOGS_DIR/AUDIT_FILE/SNAPSHOT_DIR are bound as module-level
// consts evaluated at import time. Every dist module in the audit-ledger transitive closure
// (buildlib/context.js, rock-restore.js, safety/index.js, safety/audit.js, safety/ledger.js)
// is therefore loaded via a dynamic `await import(...)` AFTER the env var is set — same
// pattern as test/verify-blockedit.mjs and test/verify-restore.mjs.
//
// This test NEVER touches the real logs/ directory: ROCK_LOGS_DIR points at a scratch temp
// dir created fresh for this run and removed at the end (best-effort). NO live Rock calls —
// every RockClient is a hand-rolled mock recording every call it receives.
//
// Run: node test/verify-buildlib.mjs

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'rock-buildlib-test-'));
process.env.ROCK_LOGS_DIR = scratch;
delete process.env.ROCK_AUDIT_FILE;
delete process.env.ROCK_MANIFEST_FILE;
mkdirSync(join(scratch, 'snapshots'), { recursive: true });

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

console.log('\n== src/buildlib/ unit tests (offline) ==\n');

// ---- Dynamic imports AFTER env var is set (see header comment) ----
const { createBuildContext, parseBuildArgs, localISO, esc, bit, sqlVal } = await import('../dist/buildlib/index.js');
const { classifyRestore } = await import('../dist/tools/rock-restore.js');
const { AUDIT_FILE, SNAPSHOT_DIR } = await import('../dist/safety/audit.js');
const { readLedgerRecords } = await import('../dist/safety/ledger.js');
const { readManifest } = await import('../dist/safety/manifest.js');

check('audit.ts AUDIT_FILE resolved under scratch dir', AUDIT_FILE.startsWith(scratch));
check('audit.ts SNAPSHOT_DIR resolved under scratch dir', SNAPSHOT_DIR.startsWith(scratch));

// ---------------------------------------------------------------------------------------
// Mock RockClient — records every call; canned responses keyed by "fn:path" (+ $filter for
// GETs, matching verify-blockedit.mjs's convention). Unmocked v1Get/executeSql calls return
// safe empty defaults (empty array) rather than throwing, since many buildlib methods probe
// before deciding what to do; tests that care about a specific probe result configure it.
// ---------------------------------------------------------------------------------------
function makeMockClient(responses = {}) {
  const calls = [];
  let nextPostId = 9000;
  const client = {
    calls,
    async v1Get(path, params) {
      calls.push({ fn: 'v1Get', path, params });
      const filterSuffix = params && params.$filter ? `?$filter=${params.$filter}` : '';
      const key = `v1Get:${path}${filterSuffix}`;
      if (key in responses) {
        const v = responses[key];
        if (typeof v === 'function') return v();
        if (v === '__404__') throw new Error(`Rock v1 GET ${path} → 404: not found`);
        return v;
      }
      return [];
    },
    async v1Post(path, body) {
      calls.push({ fn: 'v1Post', path, body });
      const key = `v1Post:${path}`;
      if (key in responses) {
        const v = responses[key];
        if (typeof v === 'function') return v(body);
        return v;
      }
      return { Id: nextPostId++ };
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
      for (const [k, v] of Object.entries(responses)) {
        if (k.startsWith('executeSql:') && sql.includes(k.slice('executeSql:'.length))) {
          return typeof v === 'function' ? v() : v;
        }
      }
      return [];
    },
    async executeSqlCommand(sql) {
      calls.push({ fn: 'executeSqlCommand', sql });
      return 1;
    },
  };
  return client;
}

// =========================================================================================
// 1. Dry-run default: ZERO client calls, ZERO ledger writes, logs intent (·/[dry-run] style)
// =========================================================================================
{
  const client = makeMockClient();
  const ctx = createBuildContext({ projectSlug: 'test-proj', client }); // go omitted -> defaults false
  check('1a. ctx.go defaults to false', ctx.go === false);

  const captured = [];
  const origLog = console.log;
  console.log = (...a) => captured.push(a.join(' '));
  let createResult;
  try {
    createResult = await ctx.create('Pages', { InternalName: 'Test Page' });
  } finally {
    console.log = origLog;
  }
  check('1b. dry-run create() returns dryRun:true', createResult.dryRun === true);
  check('1c. dry-run create() issued ZERO client calls', client.calls.length === 0);
  const recordsAfterDryCreate = await readLedgerRecords();
  check('1d. dry-run create() wrote ZERO ledger records', recordsAfterDryCreate.length === 0);
  check('1e. dry-run create() logged the intended operation', captured.some((l) => /dry-run/i.test(l) && /Pages/.test(l)));

  const patchResult = await ctx.patch('Blocks', 42, { Name: 'New Name' });
  check('1f. dry-run patch() returns dryRun:true', patchResult.dryRun === true);
  check('1g. dry-run patch() issued ZERO client calls', client.calls.length === 0);

  const manifestAfterDry = readManifest();
  check('1h. dry-run wrote nothing to the manifest', Object.keys(manifestAfterDry).length === 0);
}

// =========================================================================================
// 2. go:true create() — POSTs, tags ForeignKey=slug, ledgers phase 'create' w/ newId,
//    records manifest entry.
// =========================================================================================
{
  const client = makeMockClient({ 'v1Post:Pages': { Id: 5001 } });
  const ctx = createBuildContext({ projectSlug: 'acme-build', client, go: true });
  const result = await ctx.create('Pages', { InternalName: 'Acme Page' }, { manifestKey: 'acmePage' });

  check('2a. go:true create() returns { id, auditId }', result.id === 5001 && typeof result.auditId === 'string');
  const postCall = client.calls.find((c) => c.fn === 'v1Post');
  check('2b. go:true create() issued exactly ONE v1Post call', client.calls.filter((c) => c.fn === 'v1Post').length === 1);
  check('2c. POST body stamped ForeignKey = projectSlug', postCall.body.ForeignKey === 'acme-build');
  check('2d. POST body retains the original fields', postCall.body.InternalName === 'Acme Page');

  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('2e. ledger record exists', !!rec);
  check('2f. ledger record phase is "create"', rec && rec.phase === 'create');
  check('2g. ledger record verb/mode are create/rest', rec && rec.verb === 'create' && rec.mode === 'rest');
  check('2h. ledger record tool is "build-script:acme-build"', rec && rec.tool === 'build-script:acme-build');
  check('2i. ledger record target.entityType is the NORMALIZED SINGULAR (not the raw plural controller — see the create() restore-compat deviation note)', rec && rec.target.entityType === 'Page');
  check('2j. ledger record result.newId === 5001', rec && rec.result.newId === 5001);
  check('2k. ledger payload.body carries the tagged ForeignKey', rec && rec.payload.body.ForeignKey === 'acme-build');

  const manifest = readManifest();
  check('2l. manifest recorded under the projectSlug section', manifest['acme-build'] && manifest['acme-build'].acmePage === 5001);
}

// =========================================================================================
// 3. tag:false skips ForeignKey stamping
// =========================================================================================
{
  const client = makeMockClient({ 'v1Post:Blocks': { Id: 6001 } });
  const ctx = createBuildContext({ projectSlug: 'no-tag-proj', client, go: true });
  const result = await ctx.create('Blocks', { Name: 'Untagged' }, { tag: false });
  const postCall = client.calls.find((c) => c.fn === 'v1Post');
  check('3a. tag:false → POST body has NO ForeignKey key', !Object.prototype.hasOwnProperty.call(postCall.body, 'ForeignKey'));
  check('3b. create still succeeded and ledgered', typeof result.auditId === 'string');
}

// tag defaults true but does NOT override an existing ForeignKey the caller already set.
{
  const client = makeMockClient({ 'v1Post:Blocks': { Id: 6002 } });
  const ctx = createBuildContext({ projectSlug: 'proj-x', client, go: true });
  await ctx.create('Blocks', { Name: 'Custom FK', ForeignKey: 'caller-supplied' });
  const postCall = client.calls.find((c) => c.fn === 'v1Post');
  check('3c. an explicit ForeignKey on the body is NOT overwritten', postCall.body.ForeignKey === 'caller-supplied');
}

// =========================================================================================
// 4. ensure() reuses existing (no POST) vs creates
// =========================================================================================
{
  const client = makeMockClient({
    'v1Get:Categories?$filter=Name eq \'HR\'': [{ Id: 777, Name: 'HR' }],
  });
  const ctx = createBuildContext({ projectSlug: 'ensure-proj', client, go: true });
  const result = await ctx.ensure('Categories', "Name eq 'HR'", { Name: 'HR' });
  check('4a. ensure() with an existing match returns created:false', result.created === false);
  check('4b. ensure() with an existing match returns the existing Id', result.id === 777);
  check('4c. ensure() with an existing match issued NO v1Post call', !client.calls.some((c) => c.fn === 'v1Post'));
}
{
  const client = makeMockClient({
    'v1Get:Categories?$filter=Name eq \'NewOne\'': [],
    'v1Post:Categories': { Id: 888 },
  });
  const ctx = createBuildContext({ projectSlug: 'ensure-proj2', client, go: true });
  const result = await ctx.ensure('Categories', "Name eq 'NewOne'", { Name: 'NewOne' });
  check('4d. ensure() with no match returns created:true', result.created === true);
  check('4e. ensure() with no match returns the new Id', result.id === 888);
  check('4f. ensure() with no match DID issue a v1Post call', client.calls.some((c) => c.fn === 'v1Post'));
  check('4g. ensure() with no match ledgered a create-phase record', typeof result.auditId === 'string');
}
// ensure() in dry-run mode: probe still runs (read-only), but create is gated.
{
  const client = makeMockClient({ 'v1Get:Categories?$filter=Name eq \'DryOne\'': [] });
  const ctx = createBuildContext({ projectSlug: 'ensure-dry', client, go: false });
  const result = await ctx.ensure('Categories', "Name eq 'DryOne'", { Name: 'DryOne' });
  check('4h. ensure() dry-run with no match returns dryRun:true (not a real create)', result.dryRun === true);
  check('4i. ensure() dry-run still ran the read-only probe GET', client.calls.some((c) => c.fn === 'v1Get'));
  check('4j. ensure() dry-run issued NO v1Post', !client.calls.some((c) => c.fn === 'v1Post'));
}

// =========================================================================================
// 5. findByForeignKey()
// =========================================================================================
{
  const client = makeMockClient({
    "v1Get:People?$filter=ForeignKey eq 'my-slug'": [{ Id: 1, ForeignKey: 'my-slug' }],
  });
  const ctx = createBuildContext({ projectSlug: 'my-slug', client, go: true });
  const rows = await ctx.findByForeignKey('People');
  check('5a. findByForeignKey defaults to ctx.projectSlug', rows.length === 1 && rows[0].Id === 1);

  const client2 = makeMockClient({
    "v1Get:People?$filter=ForeignKey eq 'other-slug'": [{ Id: 2 }],
  });
  const ctx2 = createBuildContext({ projectSlug: 'my-slug', client: client2, go: true });
  const rows2 = await ctx2.findByForeignKey('People', 'other-slug');
  check('5b. findByForeignKey accepts an explicit foreignKey override', rows2.length === 1 && rows2[0].Id === 2);
}

// =========================================================================================
// 6. upsertAttributeValue() patch-vs-post branches
// =========================================================================================
{
  // No existing row -> POST (create).
  const client = makeMockClient({
    'v1Post:AttributeValues': { Id: 3001 },
  });
  const ctx = createBuildContext({ projectSlug: 'attr-proj', client, go: true });
  const result = await ctx.upsertAttributeValue(100, 200, 'hello');
  check('6a. upsertAttributeValue with no existing row creates', result.created === true);
  const sqlProbe = client.calls.find((c) => c.fn === 'executeSql');
  check('6b. upsertAttributeValue probes via executeSql (SQL-probe, never SQL-write)', !!sqlProbe && /SELECT/i.test(sqlProbe.sql));
  check('6c. probe targets AttributeValue WHERE AttributeId/EntityId', /AttributeId = 100/.test(sqlProbe.sql) && /EntityId = 200/.test(sqlProbe.sql));
  const postCall = client.calls.find((c) => c.fn === 'v1Post');
  check('6d. create path POSTs AttributeValues with the right AttributeId/EntityId/Value', postCall.body.AttributeId === 100 && postCall.body.EntityId === 200 && postCall.body.Value === 'hello');
  check('6e. no v1Patch issued on the create path', !client.calls.some((c) => c.fn === 'v1Patch'));
}
{
  // Existing row with a DIFFERENT value -> PATCH.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    return [{ Id: 4001, Value: 'old-value' }];
  };
  const ctx = createBuildContext({ projectSlug: 'attr-proj2', client, go: true });
  const result = await ctx.upsertAttributeValue(101, 201, 'new-value');
  check('6f. upsertAttributeValue with an existing DIFFERENT value patches', result.created === false && result.id === 4001);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('6g. PATCH targets AttributeValues/<existing id>', !!patchCall && patchCall.path === 'AttributeValues/4001');
  check('6h. PATCH body is exactly { Value: <new> }', patchCall.body.Value === 'new-value' && Object.keys(patchCall.body).length === 1);
  check('6i. no v1Post issued on the patch path', !client.calls.some((c) => c.fn === 'v1Post'));
  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('6j. patch path ledgered phase "executed"', rec && rec.phase === 'executed');
}
{
  // Existing row with the SAME value -> no-op, no write at all.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    return [{ Id: 4002, Value: 'unchanged' }];
  };
  const ctx = createBuildContext({ projectSlug: 'attr-proj3', client, go: true });
  const result = await ctx.upsertAttributeValue(102, 202, 'unchanged');
  check('6k. upsertAttributeValue with matching existing value is a no-op', result.created === false && result.id === 4002);
  check('6l. no-op issued NO v1Patch and NO v1Post', !client.calls.some((c) => c.fn === 'v1Patch' || c.fn === 'v1Post'));
}

// =========================================================================================
// 7. touchAndFlush() field mapping both kinds + benign marker
// =========================================================================================
{
  const client = makeMockClient({
    'v1Get:HtmlContents/7001': { Id: 7001, Content: '<p>x</p>', ApprovedDateTime: '2026-01-01T00:00:00' },
  });
  const ctx = createBuildContext({ projectSlug: 'touch-proj', client, go: true });
  const result = await ctx.touchAndFlush('htmlcontent', 7001);
  check('7a. touchAndFlush(htmlcontent) returns kind/id', result.kind === 'htmlcontent' && result.id === 7001);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('7b. touchAndFlush(htmlcontent) PATCHes HtmlContents/<id>', !!patchCall && patchCall.path === 'HtmlContents/7001');
  check('7c. touchAndFlush(htmlcontent) PATCH body sets ApprovedDateTime', typeof patchCall.body.ApprovedDateTime === 'string');
  check('7d. touchAndFlush(htmlcontent) PATCH body has NO Z suffix (wall-clock, not UTC)', !patchCall.body.ApprovedDateTime.endsWith('Z'));
  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('7e. touchAndFlush ledgers phase "executed"', rec && rec.phase === 'executed');
  check('7f. touchAndFlush ledger payload carries benign:true', rec && rec.payload.benign === true);
}
{
  const client = makeMockClient({
    'v1Get:WorkflowTypes/7002': { Id: 7002, Name: 'Some Type', ModifiedDateTime: '2026-01-01T00:00:00' },
  });
  const ctx = createBuildContext({ projectSlug: 'touch-proj2', client, go: true });
  const result = await ctx.touchAndFlush('workflowtype', 7002);
  check('7g. touchAndFlush(workflowtype) returns kind/id', result.kind === 'workflowtype' && result.id === 7002);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('7h. touchAndFlush(workflowtype) PATCHes WorkflowTypes/<id>', !!patchCall && patchCall.path === 'WorkflowTypes/7002');
  check('7i. touchAndFlush(workflowtype) PATCH body sets ModifiedDateTime (not ApprovedDateTime)', typeof patchCall.body.ModifiedDateTime === 'string' && patchCall.body.ApprovedDateTime === undefined);
  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('7j. touchAndFlush(workflowtype) ledger payload also carries benign:true', rec && rec.payload.benign === true);
}
// dry-run touchAndFlush issues no client calls.
{
  const client = makeMockClient();
  const ctx = createBuildContext({ projectSlug: 'touch-dry', client, go: false });
  const result = await ctx.touchAndFlush('htmlcontent', 9999);
  check('7k. dry-run touchAndFlush returns dryRun:true', result.dryRun === true);
  check('7l. dry-run touchAndFlush issued ZERO client calls', client.calls.length === 0);
}

// =========================================================================================
// 8. updateBlockContent() version bump (mock existing v3 → POSTs v4) + flush PATCH on the
//    NEW row id (not the old one).
// =========================================================================================
{
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 8001': [
      { Id: 111, BlockId: 8001, Version: 1 },
      { Id: 112, BlockId: 8001, Version: 3 },
      { Id: 113, BlockId: 8001, Version: 2 },
    ],
    'v1Post:HtmlContents': { Id: 999 },
    'v1Get:HtmlContents/999': { Id: 999, BlockId: 8001, Version: 4 },
  });
  const ctx = createBuildContext({ projectSlug: 'ubc-proj', client, go: true });
  const result = await ctx.updateBlockContent(8001, '<div>new content</div>');
  check('8a. updateBlockContent computes version = max(existing)+1 = 4', result.version === 4);
  check('8b. updateBlockContent returns the NEW HtmlContent id (999, from the mocked POST)', result.newHtmlContentId === 999);

  const postCall = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'HtmlContents');
  check('8c. POST creates a NEW HtmlContent row (not a patch of an existing one)', !!postCall);
  check('8d. POST body has BlockId/Content/EntityValue/Version/IsApproved', postCall.body.BlockId === 8001 && postCall.body.Content === '<div>new content</div>' && postCall.body.EntityValue === '' && postCall.body.Version === 4 && postCall.body.IsApproved === true);

  const patchCalls = client.calls.filter((c) => c.fn === 'v1Patch');
  check('8e. exactly ONE v1Patch call (the cache-flush PATCH)', patchCalls.length === 1);
  check('8f. the flush PATCH targets the NEW row id (999), NOT an old version (111/112/113)', patchCalls[0].path === 'HtmlContents/999');
  check('8g. the flush PATCH sets ApprovedDateTime', typeof patchCalls[0].body.ApprovedDateTime === 'string');

  check('8h. returns both a create auditId and a flush auditId', typeof result.createAuditId === 'string' && typeof result.flushAuditId === 'string' && result.createAuditId !== result.flushAuditId);
}
// No existing rows -> version 1.
{
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 8002': [],
    'v1Post:HtmlContents': { Id: 501 },
    'v1Get:HtmlContents/501': { Id: 501, BlockId: 8002, Version: 1 },
  });
  const ctx = createBuildContext({ projectSlug: 'ubc-proj2', client, go: true });
  const result = await ctx.updateBlockContent(8002, 'first content ever');
  check('8i. updateBlockContent with no prior rows starts at version 1', result.version === 1);
}
// Dry-run still probes (read-only) to report the intended version, but issues no writes.
{
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 8003': [{ Id: 1, BlockId: 8003, Version: 5 }],
  });
  const ctx = createBuildContext({ projectSlug: 'ubc-dry', client, go: false });
  const result = await ctx.updateBlockContent(8003, 'would-be content');
  check('8j. dry-run updateBlockContent returns dryRun:true', result.dryRun === true);
  check('8k. dry-run updateBlockContent issued NO v1Post/v1Patch', !client.calls.some((c) => c.fn === 'v1Post' || c.fn === 'v1Patch'));
}

// =========================================================================================
// 9. lockToGroups() exact order + deny-last shape (SpecialRole:1, 'D')
// =========================================================================================
{
  const client = makeMockClient();
  const ctx = createBuildContext({ projectSlug: 'lock-proj', client, go: true });
  const result = await ctx.lockToGroups(2, 12345, [10, 20, 30], 'View');
  const postCalls = client.calls.filter((c) => c.fn === 'v1Post' && c.path === 'Auths');
  check('9a. lockToGroups issued exactly 4 Auths POSTs (3 groups + 1 deny)', postCalls.length === 4);
  check('9b. row 0: group 10, Allow, SpecialRole 0, Order 0', postCalls[0].body.GroupId === 10 && postCalls[0].body.AllowOrDeny === 'A' && postCalls[0].body.SpecialRole === 0 && postCalls[0].body.Order === 0);
  check('9c. row 1: group 20, Allow, Order 1', postCalls[1].body.GroupId === 20 && postCalls[1].body.AllowOrDeny === 'A' && postCalls[1].body.Order === 1);
  check('9d. row 2: group 30, Allow, Order 2', postCalls[2].body.GroupId === 30 && postCalls[2].body.AllowOrDeny === 'A' && postCalls[2].body.Order === 2);
  check('9e. row 3 (LAST): Deny, SpecialRole 1, Order 3, NO GroupId', postCalls[3].body.AllowOrDeny === 'D' && postCalls[3].body.SpecialRole === 1 && postCalls[3].body.Order === 3 && postCalls[3].body.GroupId === undefined);
  check('9f. all rows carry the same EntityTypeId/EntityId/Action', postCalls.every((c) => c.body.EntityTypeId === 2 && c.body.EntityId === 12345 && c.body.Action === 'View'));
  check('9g. result.rows has 4 entries with auditIds', result.rows.length === 4 && result.rows.every((r) => typeof r.auditId === 'string'));
}
// dry-run lockToGroups issues no writes.
{
  const client = makeMockClient();
  const ctx = createBuildContext({ projectSlug: 'lock-dry', client, go: false });
  const result = await ctx.lockToGroups(2, 1, [1, 2], 'View');
  check('9h. dry-run lockToGroups returns dryRun:true', result.dryRun === true);
  check('9i. dry-run lockToGroups issued ZERO client calls', client.calls.length === 0);
}

// =========================================================================================
// 10. widenAccess() computes MAX+1 and pushes deny down when present
// =========================================================================================
{
  // No existing allow, no existing deny -> straightforward MAX(Order)+1 grant, no pushdown.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    if (/AllowOrDeny = 'A'/.test(sql)) return []; // no existing allow
    if (/AllowOrDeny = 'D'/.test(sql)) return []; // no existing deny
    if (/MAX\(\[Order\]\)/.test(sql)) return [{ M: 2 }]; // existing rows at Order 0,1,2
    return [];
  };
  const ctx = createBuildContext({ projectSlug: 'widen-proj', client, go: true });
  const result = await ctx.widenAccess(32, 384, { groupId: 555 }, 'View');
  check('10a. widenAccess computes order = MAX(Order)+1 = 3', result.order === 3);
  check('10b. widenAccess reports no deny pushdown when none existed', result.movedDenyToBottom === undefined);
  const postCall = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'Auths');
  check('10c. widenAccess POSTs an Allow row with GroupId + computed Order', postCall.body.GroupId === 555 && postCall.body.AllowOrDeny === 'A' && postCall.body.Order === 3);
  check('10d. no v1Patch issued when there was nothing to push down', !client.calls.some((c) => c.fn === 'v1Patch'));
}
{
  // Existing SpecialRole:1 Deny-all present -> push it to Order 50 FIRST, then grant.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    if (/AllowOrDeny = 'A'/.test(sql)) return [];
    if (/AllowOrDeny = 'D'/.test(sql)) return [{ Id: 42, Order: 1 }]; // existing deny-all at Order 1
    if (/MAX\(\[Order\]\)/.test(sql)) return [{ M: 1 }];
    return [];
  };
  const ctx = createBuildContext({ projectSlug: 'widen-proj2', client, go: true });
  const result = await ctx.widenAccess(2, 3249, { personAliasId: 17345 }, 'View');
  check('10e. widenAccess reports the deny pushdown (authId 42 -> Order 50)', result.movedDenyToBottom && result.movedDenyToBottom.authId === 42 && result.movedDenyToBottom.newOrder === 50);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('10f. widenAccess PATCHed Auths/42 with Order:50', !!patchCall && patchCall.path === 'Auths/42' && patchCall.body.Order === 50);
  const postCall = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'Auths');
  check('10g. widenAccess then POSTs the new Allow for the personAliasId', postCall.body.PersonAliasId === 17345 && postCall.body.AllowOrDeny === 'A');
  // Ordering: the PATCH (pushdown) must happen before the POST (new allow) in the call log.
  const patchIdx = client.calls.findIndex((c) => c.fn === 'v1Patch');
  const postIdx = client.calls.findIndex((c) => c.fn === 'v1Post');
  check('10h. deny pushdown PATCH happens BEFORE the new-allow POST', patchIdx !== -1 && postIdx !== -1 && patchIdx < postIdx);
}
{
  // Idempotent: an existing Allow for this exact target -> no-op, no writes.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    if (/AllowOrDeny = 'A'/.test(sql)) return [{ Id: 900 }];
    return [];
  };
  const ctx = createBuildContext({ projectSlug: 'widen-proj3', client, go: true });
  const result = await ctx.widenAccess(32, 384, { groupId: 555 }, 'View');
  check('10i. widenAccess is idempotent — existing allow found, returns it with order:-1 sentinel', result.id === 900);
  check('10j. widenAccess idempotent path issued NO v1Post/v1Patch', !client.calls.some((c) => c.fn === 'v1Post' || c.fn === 'v1Patch'));
}
{
  // Requires a groupId or personAliasId.
  const client = makeMockClient();
  const ctx = createBuildContext({ projectSlug: 'widen-bad', client, go: true });
  await checkThrows('10k. widenAccess throws without groupId/personAliasId', () => ctx.widenAccess(2, 1, {}, 'View'), /requires target.groupId or target.personAliasId/);
}
{
  // SECURITY-ORDERING FIX: deny-pushdown must keep the new Allow strictly ABOVE the pushed
  // deny even when MAX(Order) >= 50 (the corpus's literal Order-50 push would have left the
  // Allow BELOW the deny here — first-match-wins would silently never apply the grant).
  // Seed: existing deny-all at Order 60, which is also the MAX row.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    if (/AllowOrDeny = 'A'/.test(sql)) return [];
    if (/AllowOrDeny = 'D'/.test(sql)) return [{ Id: 77, Order: 60 }];
    if (/MAX\(\[Order\]\)/.test(sql)) return [{ M: 60 }];
    return [];
  };
  const ctx = createBuildContext({ projectSlug: 'widen-high-order', client, go: true });
  const result = await ctx.widenAccess(2, 5000, { groupId: 9 }, 'View');
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  const postCall = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'Auths');
  check('10l. MAX(Order)=60: allow lands at 61 (MAX+1)', result.order === 61 && postCall.body.Order === 61);
  check('10m. MAX(Order)=60: deny pushed to 62 (Math.max(50, allowOrder+1)), NOT the literal 50', !!patchCall && patchCall.body.Order === 62 && result.movedDenyToBottom && result.movedDenyToBottom.newOrder === 62);
  check('10n. allow Order strictly BELOW pushed deny Order (first-match-wins safe)', postCall.body.Order < patchCall.body.Order);
}
{
  // Same high-Order seed, dry-run: detail must report BOTH computed numbers, and no writes.
  const client = makeMockClient();
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    if (/AllowOrDeny = 'A'/.test(sql)) return [];
    if (/AllowOrDeny = 'D'/.test(sql)) return [{ Id: 77, Order: 60 }];
    if (/MAX\(\[Order\]\)/.test(sql)) return [{ M: 60 }];
    return [];
  };
  const ctx = createBuildContext({ projectSlug: 'widen-high-dry', client, go: false });
  const result = await ctx.widenAccess(2, 5000, { groupId: 9 }, 'View');
  check('10o. dry-run detail reports allowOrder=61 AND wouldPushDeny.to=62', result.dryRun === true && result.detail.allowOrder === 61 && result.detail.wouldPushDeny && result.detail.wouldPushDeny.to === 62);
  check('10p. dry-run high-Order path issued NO v1Post/v1Patch', !client.calls.some((c) => c.fn === 'v1Post' || c.fn === 'v1Patch'));
}

// =========================================================================================
// 11. createWorkflowAction(): SQL passes validateWrite, guid read-back verify (throw on
//     miss), ledger mode 'sql'
// =========================================================================================
{
  const client = makeMockClient();
  let insertedSql;
  client.executeSqlCommand = async (sql) => {
    client.calls.push({ fn: 'executeSqlCommand', sql });
    insertedSql = sql;
    return 1;
  };
  client.executeSql = async (sql) => {
    client.calls.push({ fn: 'executeSql', sql });
    // Verify-by-guid: match the guid embedded in the INSERT we just captured.
    const m = /Guid = '([0-9a-fA-F-]+)'/.exec(sql);
    if (m && insertedSql && insertedSql.includes(`'${m[1]}'`)) return [{ Id: 55555 }];
    return [];
  };
  const ctx = createBuildContext({ projectSlug: 'wf-action-proj', client, go: true });
  const result = await ctx.createWorkflowAction(200, { name: 'Send Email', component: 157, order: 0 });
  check('11a. createWorkflowAction returns the verified Id', result.id === 55555);
  check('11b. createWorkflowAction returns a guid', typeof result.guid === 'string' && result.guid.length > 0);
  check('11c. createWorkflowAction executed the INSERT via executeSqlCommand (not v1Post)', client.calls.some((c) => c.fn === 'executeSqlCommand') && !client.calls.some((c) => c.fn === 'v1Post'));
  check('11d. the executed SQL is a single INSERT INTO WorkflowActionType', /^INSERT INTO WorkflowActionType/.test(insertedSql));
  check('11e. the executed SQL embeds the escaped Name literal', insertedSql.includes("N'Send Email'"));
  check('11f. createWorkflowAction returns a reminder to touchAndFlush the WorkflowType', /touchAndFlush/.test(result.reminder) && /workflowtype/.test(result.reminder));

  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('11g. ledger record exists for the workflow action', !!rec);
  check('11h. ledger mode is "sql"', rec && rec.mode === 'sql');
  check('11i. ledger phase is "create"', rec && rec.phase === 'create');
  check('11j. ledger target.entityType is WorkflowActionType', rec && rec.target.entityType === 'WorkflowActionType');
  check('11k. ledger result.newId matches the verified Id', rec && rec.result.newId === 55555);
}
// Guid read-back miss -> throw (never silently return an unverified id).
await checkThrows(
  '11l. createWorkflowAction throws when the guid read-back finds nothing',
  async () => {
    const client = makeMockClient();
    client.executeSqlCommand = async () => 1;
    client.executeSql = async () => []; // never finds the row
    const ctx = createBuildContext({ projectSlug: 'wf-action-miss', client, go: true });
    return ctx.createWorkflowAction(200, { name: 'Ghost Action', component: 157, order: 0 });
  },
  /insert verify failed/i
);
// SQL injection / dangerous-keyword attempt in the name is escaped, not rejected (esc()
// doubles quotes) — but a genuinely dangerous op should never reach executeSqlCommand
// because createWorkflowAction only ever builds a single INSERT; sanity-check validateWrite
// is actually being consulted by making the name contain a quote that must be escaped.
{
  const client = makeMockClient();
  let insertedSql;
  client.executeSqlCommand = async (sql) => { insertedSql = sql; return 1; };
  client.executeSql = async (sql) => {
    const m = /Guid = '([0-9a-fA-F-]+)'/.exec(sql);
    return m && insertedSql && insertedSql.includes(`'${m[1]}'`) ? [{ Id: 1 }] : [];
  };
  const ctx = createBuildContext({ projectSlug: 'wf-action-esc', client, go: true });
  await ctx.createWorkflowAction(200, { name: "O'Brien's Action", component: 157, order: 0 });
  check('11m. a quote in the action name is properly SQL-escaped (doubled)', insertedSql.includes("O''Brien''s Action"));
}
// Dry-run createWorkflowAction issues no client calls.
{
  const client = makeMockClient();
  const ctx = createBuildContext({ projectSlug: 'wf-action-dry', client, go: false });
  const result = await ctx.createWorkflowAction(200, { name: 'Dry Action', component: 157, order: 0 });
  check('11n. dry-run createWorkflowAction returns dryRun:true', result.dryRun === true);
  check('11o. dry-run createWorkflowAction issued ZERO client calls', client.calls.length === 0);
}

// =========================================================================================
// 12. patch() snapshot written + rock_edit-shaped record
// =========================================================================================
{
  const client = makeMockClient({
    'v1Get:Blocks/12001': { Id: 12001, Name: 'Old Name', Zone: 'Main' },
  });
  const ctx = createBuildContext({ projectSlug: 'patch-proj', client, go: true, label: 'default context label' });
  const result = await ctx.patch('Blocks', 12001, { Name: 'New Name' }, { label: 'rename block' });
  check('12a. patch() returns { auditId, snapshotRef }', typeof result.auditId === 'string' && typeof result.snapshotRef === 'string');

  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('12b. PATCH targets controller/id', patchCall.path === 'Blocks/12001');
  check('12c. PATCH body is exactly what was passed', patchCall.body.Name === 'New Name' && Object.keys(patchCall.body).length === 1);

  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('12d. executed ledger record exists', !!rec);
  check('12e. executed ledger record is EXACTLY the rock_edit shape: phase executed, verb edit, mode rest', rec && rec.phase === 'executed' && rec.verb === 'edit' && rec.mode === 'rest');
  check('12f. executed ledger target has NORMALIZED SINGULAR entityType + id (matches rockEdit\'s convention)', rec && rec.target.entityType === 'Block' && rec.target.id === 12001);
  check('12g. executed ledger payload is { label, body } (rock_edit-compatible shape)', rec && rec.payload.label === 'rename block' && rec.payload.body.Name === 'New Name');
  check('12h. executed ledger record has a snapshotRef', rec && typeof rec.snapshotRef === 'string');

  // The snapshot file itself was written to disk with the BEFORE state.
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const snapPath = join(SNAPSHOT_DIR, basename(rec.snapshotRef));
  const snapContent = JSON.parse(await readFile(snapPath, 'utf8'));
  check('12i. snapshot file on disk holds the BEFORE row (Name: "Old Name")', snapContent.Name === 'Old Name');
}
// context-level default label is used when no per-call label given.
{
  const client = makeMockClient({ 'v1Get:Blocks/12002': { Id: 12002, Name: 'X' } });
  const ctx = createBuildContext({ projectSlug: 'patch-proj2', client, go: true, label: 'ctx default label' });
  const result = await ctx.patch('Blocks', 12002, { Name: 'Y' });
  const records = await readLedgerRecords();
  const rec = records.find((r) => r.auditId === result.auditId);
  check('12j. patch() falls back to the context default label when none is passed per-call', rec && rec.payload.label === 'ctx default label');
}

// =========================================================================================
// 13. Restore-compat (THE ARC-3 acceptance bar) — classifyRestore on a buildlib patch()
//     record yields a patch-back plan restoring the before values; classifyRestore on a
//     buildlib create() record yields an undo-create plan targeting the new id.
// =========================================================================================
{
  const client = makeMockClient({
    'v1Get:Blocks/13001': { Id: 13001, Name: 'Restore-Compat Before', Zone: 'Main', OutputCacheDuration: 0 },
  });
  const ctx = createBuildContext({ projectSlug: 'restore-compat-patch', client, go: true });
  const patchResult = await ctx.patch('Blocks', 13001, { Name: 'Restore-Compat After' }, { label: 'compat check' });

  const records = await readLedgerRecords();
  const execRec = records.find((r) => r.auditId === patchResult.auditId);
  check('13a. found the executed patch ledger record to classify', !!execRec);

  const plan = await classifyRestore(execRec);
  check('13b. classifyRestore does NOT refuse a buildlib patch() record', plan.kind !== 'refuse' && plan.kind !== 'sql-refuse');
  check('13c. classifyRestore yields a patch-back plan (case c) for buildlib patch()', plan.kind === 'patch-back');
  check('13d. patch-back plan targets the same controller/id', plan.kind === 'patch-back' && plan.controller === 'Blocks' && plan.id === 13001);
  check(
    '13e. patch-back plan body restores Name to the BEFORE value from the snapshot',
    plan.kind === 'patch-back' && plan.body.Name === 'Restore-Compat Before'
  );
}
{
  const client = makeMockClient({ 'v1Post:Groups': { Id: 88001 } });
  const ctx = createBuildContext({ projectSlug: 'restore-compat-create', client, go: true });
  const createResult = await ctx.create('Groups', { Name: 'Restore Compat Group' }, { manifestKey: 'compatGroup' });

  const records = await readLedgerRecords();
  const execRec = records.find((r) => r.auditId === createResult.auditId);
  check('13f. found the create ledger record to classify', !!execRec);

  const plan = await classifyRestore(execRec);
  check('13g. classifyRestore does NOT refuse a buildlib create() record', plan.kind !== 'refuse' && plan.kind !== 'sql-refuse');
  check('13h. classifyRestore yields an undo-create plan (case b) for buildlib create()', plan.kind === 'undo-create' && plan.mode === 'rest');
  check('13i. undo-create plan targets the NEW id (88001)', plan.kind === 'undo-create' && plan.id === 88001);
  check('13j. undo-create plan controller matches the entity type (Groups)', plan.kind === 'undo-create' && plan.controller === 'Groups');
}
// Restore-compat also holds for the SQL-mode createWorkflowAction() record (case f).
{
  const client = makeMockClient();
  let insertedSql;
  client.executeSqlCommand = async (sql) => { insertedSql = sql; return 1; };
  client.executeSql = async (sql) => {
    const m = /Guid = '([0-9a-fA-F-]+)'/.exec(sql);
    return m && insertedSql && insertedSql.includes(`'${m[1]}'`) ? [{ Id: 77001 }] : [];
  };
  const ctx = createBuildContext({ projectSlug: 'restore-compat-wf', client, go: true });
  const result = await ctx.createWorkflowAction(300, { name: 'Compat Action', component: 157, order: 0 });

  const records = await readLedgerRecords();
  const execRec = records.find((r) => r.auditId === result.auditId);
  const plan = await classifyRestore(execRec);
  check('13k. classifyRestore yields a SQL undo-create plan (case f) for createWorkflowAction()', plan.kind === 'undo-create' && plan.mode === 'sql');
  check('13l. SQL undo-create plan targets WorkflowActionType / the verified Id', plan.kind === 'undo-create' && plan.mode === 'sql' && plan.table === 'WorkflowActionType' && plan.id === 77001);
}

// =========================================================================================
// 14. parseBuildArgs
// =========================================================================================
{
  check('14a. parseBuildArgs([]) -> go:false, flags:[]', parseBuildArgs([]).go === false && parseBuildArgs([]).flags.length === 0);
  const withGo = parseBuildArgs(['--go']);
  check('14b. parseBuildArgs(["--go"]) -> go:true', withGo.go === true);
  check('14c. parseBuildArgs(["--go"]) -> flags excludes --go itself', withGo.flags.length === 0);
  const mixed = parseBuildArgs(['--update-user', '--go', '--all']);
  check('14d. parseBuildArgs mixed flags -> go:true extracted', mixed.go === true);
  check('14e. parseBuildArgs mixed flags -> other flags preserved in order', mixed.flags.join(',') === '--update-user,--all');
  const noGo = parseBuildArgs(['--update-user', '--all']);
  check('14f. parseBuildArgs without --go -> go:false', noGo.go === false);
  check('14g. parseBuildArgs without --go -> flags preserved', noGo.flags.join(',') === '--update-user,--all');
}

// =========================================================================================
// 15. localISO produces wall-clock (no 'Z' suffix; matches local offset math) + esc/bit/sqlVal
// =========================================================================================
{
  const d = new Date(2026, 5, 15, 9, 7, 3); // June 15 2026, 09:07:03 LOCAL time (month is 0-based)
  const iso = localISO(d);
  check('15a. localISO has NO trailing "Z"', !iso.endsWith('Z'));
  check('15b. localISO matches yyyy-MM-ddTHH:mm:ss shape', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(iso));
  check('15c. localISO renders the exact local wall-clock fields (no UTC shift)', iso === '2026-06-15T09:07:03');
  // Cross-check against the Date object's own local getters directly (independent of any
  // assumption about the test runner's timezone) — this is the "matches local offset math"
  // assertion: localISO must never equal toISOString() unless the runner happens to sit at
  // UTC+0 AND the date has no offset, which isoNoZ (the OTHER, UTC-based helper) already
  // covers; here we assert equality with a hand-built local string instead.
  const now = new Date();
  const expectedNow =
    now.getFullYearAlt !== undefined
      ? '' // unreachable — placeholder to keep this block self-documenting
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  check('15d. localISO(now) matches hand-built local-getter string', localISO(now) === expectedNow);

  check('15e. esc doubles embedded single quotes', esc("O'Brien") === "O''Brien");
  check('15f. bit(true) === 1, bit(false) === 0', bit(true) === 1 && bit(false) === 0);
  check('15g. sqlVal(null) === "NULL"', sqlVal(null) === 'NULL');
  check('15h. sqlVal(undefined) === "NULL"', sqlVal(undefined) === 'NULL');
  check('15i. sqlVal("x") === "N\'x\'"', sqlVal('x') === "N'x'");
  check('15j. sqlVal escapes embedded quotes', sqlVal("a'b") === "N'a''b'");
}

// =========================================================================================
// 16. create() with an unparseable new Id: ledger THEN throw (ledger truthfulness).
//     The POST returned 2xx so the row may exist in Rock — that goes on the ledger
//     (result.success true, newId undefined, no manifest entry) — but the caller gets a
//     THROW, never a sentinel id that would propagate (e.g. PATCH HtmlContents/0).
// =========================================================================================
{
  const client = makeMockClient({ 'v1Post:Widgets': 'garbage — not an id' });
  const ctx = createBuildContext({ projectSlug: 'no-id-proj', client, go: true });
  let threw = null;
  try {
    await ctx.create('Widgets', { Name: 'X' }, { manifestKey: 'widgetKey' });
  } catch (e) {
    threw = e;
  }
  check('16a. create() with unparseable POST response THROWS', !!threw);
  const records = await readLedgerRecords();
  const rec = records.find((r) => r.tool === 'build-script:no-id-proj' && r.phase === 'create');
  check('16b. the create WAS ledgered before the throw (row may exist in Rock)', !!rec);
  check('16c. ledgered record has NO newId (result.newId undefined)', rec && rec.result.newId === undefined);
  check('16d. ledgered result.success stays true (the POST itself landed)', rec && rec.result.success === true);
  check('16e. thrown error names the auditId', threw && rec && threw.message.includes(rec.auditId));
  check('16f. thrown error points to findByForeignKey for recovery', threw && /findByForeignKey/.test(threw.message));
  check('16g. thrown error says the row may exist (and warns against blind retry)', threw && /may exist/i.test(threw.message) && /retry/i.test(threw.message));
  const manifest = readManifest();
  check('16h. NO manifest entry was recorded for the unidentifiable row', !(manifest['no-id-proj'] && Object.keys(manifest['no-id-proj']).length > 0));
}
{
  // updateBlockContent with the same unparseable-POST mock: the throw from create() must
  // fire BEFORE any flush PATCH (previously Number('') = 0 would have PATCHed HtmlContents/0).
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 8100': [{ Id: 1, BlockId: 8100, Version: 2 }],
    'v1Post:HtmlContents': {}, // object without Id -> unparseable
  });
  const ctx = createBuildContext({ projectSlug: 'ubc-no-id', client, go: true });
  let threw = null;
  try {
    await ctx.updateBlockContent(8100, 'content');
  } catch (e) {
    threw = e;
  }
  check('16i. updateBlockContent with unparseable create Id THROWS', !!threw && /no parseable Id/.test(threw.message));
  check('16j. NO flush PATCH fired (failed create never reaches touchAndFlush)', !client.calls.some((c) => c.fn === 'v1Patch'));
}

// =====================================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('Failures: ' + failures.join(', '));

// Best-effort cleanup — never touches the real repo's logs/ dir since scratch is under tmpdir().
try { rmSync(scratch, { recursive: true, force: true }); } catch {}

process.exit(fail ? 1 : 0);
