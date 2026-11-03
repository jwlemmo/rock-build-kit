#!/usr/bin/env node
// Pure-unit tests for create_page_bundle (no network) — the full happy-path recipe
// (Page → PageRoute → Block → HtmlContent [+ ApprovedDateTime flush] → Auth allow/deny),
// exact call ORDER, param validation, route leading-slash normalization, url_hint
// correctness, per-object ledger + manifest records, and the STOP-at-first-failure
// contract (no later steps run, created_so_far reports only what actually landed).
//
// IMPORTANT: ROCK_LOGS_DIR must be set BEFORE the safety/audit.ts and safety/manifest.ts
// modules are first imported — LOGS_DIR/AUDIT_FILE/MANIFEST_FILE are bound as module-level
// consts evaluated at import time. Every dist module in the audit-ledger transitive closure
// (page-bundle.js, safety/index.js, safety/audit.js, safety/manifest.js, safety/ledger.js)
// is therefore loaded via a dynamic `await import(...)` AFTER the env var is set — same
// pattern as test/verify-blockedit.mjs and test/verify-restore.mjs.
//
// This test NEVER touches the real logs/ directory: ROCK_LOGS_DIR points at a scratch
// temp dir created fresh for this run and removed at the end (best-effort).
//
// Run: node test/verify-pagebundle.mjs

import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'rock-pagebundle-test-'));
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

// ---- Mock RockClient: records every call in order, returns canned/sequential Ids ----
function makeMockClient(overrides = {}) {
  const calls = [];
  let nextId = 9000;
  const client = {
    calls,
    async v1Get(path, params) {
      calls.push({ fn: 'v1Get', path, params });
      if (overrides.v1Get) {
        const r = overrides.v1Get(path, params);
        if (r !== undefined) return r;
      }
      if (/^Pages\/\d+$/.test(path)) return {Id:Number(path.split('/')[1]),LayoutId:12};
      if (path === 'BlockTypes') return [{Id:6,Path:'~/Blocks/Cms/HtmlContent.ascx'}];
      if (path === 'EntityTypes') return [{Id:2,Name:'Rock.Model.Page'}];
      // Default: verify-GET succeeds by echoing back an Id parsed from the path.
      const m = /\/(\d+)$/.exec(path);
      const id = m ? Number(m[1]) : nextId++;
      return { Id: id };
    },
    async v1Post(path, body) {
      calls.push({ fn: 'v1Post', path, body });
      if (overrides.v1Post) {
        const r = overrides.v1Post(path, body, calls);
        if (r !== undefined) {
          if (r && r.__throw__) throw new Error(r.__throw__);
          return r;
        }
      }
      return { Id: nextId++ };
    },
    async v1Patch(path, body) {
      calls.push({ fn: 'v1Patch', path, body });
      if (overrides.v1Patch) {
        const r = overrides.v1Patch(path, body, calls);
        if (r && r.__throw__) throw new Error(r.__throw__);
      }
      return undefined;
    },
    async v1Delete(path) {
      calls.push({ fn: 'v1Delete', path });
      return undefined;
    },
    async executeSql() { calls.push({ fn: 'executeSql' }); return []; },
    async executeSqlCommand() { calls.push({ fn: 'executeSqlCommand' }); return 1; },
  };
  return client;
}

console.log('\n== create_page_bundle unit tests (offline) ==\n');

// ---- Dynamic imports AFTER env var is set (see header comment) ----
const { createPageBundle, createPageBundleSchema } = await import('../dist/tools/page-bundle.js');
const { AUDIT_FILE, MANIFEST_FILE } = await import('../dist/safety/audit.js').then(async (a) => {
  const m = await import('../dist/safety/manifest.js');
  return { AUDIT_FILE: a.AUDIT_FILE, MANIFEST_FILE: m.MANIFEST_FILE };
});
const { readLedgerRecords } = await import('../dist/safety/ledger.js');
const { readManifest } = await import('../dist/safety/manifest.js');

check('audit.ts AUDIT_FILE resolved under scratch dir', AUDIT_FILE.startsWith(scratch));
check('manifest.ts MANIFEST_FILE resolved under scratch dir', MANIFEST_FILE.startsWith(scratch));

// =========================================================================
// 1. Happy path with route + auth — exact call ORDER, body shapes, ledger + manifest.
// =========================================================================
{
  const client = makeMockClient({
    v1Post(path, body, callsSoFar) {
      if (path === 'Pages') return { Id: 5001 };
      if (path === 'PageRoutes') return { Id: 5002 };
      if (path === 'Blocks') return { Id: 5003 };
      if (path === 'HtmlContents') return { Id: 5004 };
      if (path === 'Auths') {
        // First Auths call = allow role 0 → 5010, second = allow role 1 → 5011, third = deny-all → 5012
        // callsSoFar includes the just-pushed current call, so subtract 1 for a 0-based count of PRIOR Auths posts.
        const priorAuthPosts = callsSoFar.filter((c) => c.fn === 'v1Post' && c.path === 'Auths').length - 1;
        return { Id: 5010 + priorAuthPosts };
      }
      return undefined;
    },
  });

  const result = await createPageBundle(client, {
    name: 'Test Admin Page',
    parent_page_id: 1235,
    content: '<div>hello</div>',
    route: 'TestAdminPage',
    allow_role_ids: [2, 3],
    label: 'Test Bundle',
  });

  check('1. success:true', result.success === true);
  check('1. page_id correct', result.page_id === 5001);
  check('1. route_id correct', result.route_id === 5002);
  check('1. block_id correct', result.block_id === 5003);
  check('1. html_content_id correct', result.html_content_id === 5004);
  check('1. auth_ids correct (allow0, allow1, deny)', Array.isArray(result.auth_ids) && result.auth_ids.length === 3 && result.auth_ids[0] === 5010 && result.auth_ids[1] === 5011 && result.auth_ids[2] === 5012);
  check('1. url_hint uses the route (leading slash, no leading-slash-stripped route)', result.url_hint === '/TestAdminPage');
  check('1. audit_ids has one entry per created object (page,route,block,htmlcontent,auth x3 = 7)', Array.isArray(result.audit_ids) && result.audit_ids.length === 7);
  check('1. operator present', result.operator && typeof result.operator.email === 'string');

  // ---- exact call order ----
  const writeCalls = client.calls.filter((c) => c.fn !== 'v1Get');
  const seq = writeCalls.map((c) => `${c.fn}:${c.path}`);
  check(
    '1. call order is Pages POST → PageRoutes POST → Blocks POST → HtmlContents POST → HtmlContents PATCH → Auths POST x3',
    seq.join(',') === [
      'v1Post:Pages',
      'v1Post:PageRoutes',
      'v1Post:Blocks',
      'v1Post:HtmlContents',
      'v1Patch:HtmlContents/5004',
      'v1Post:Auths',
      'v1Post:Auths',
      'v1Post:Auths',
    ].join(',')
  );

  // ---- verify GETs happened after all writes ----
  const lastWriteIdx = client.calls.map((c) => c.fn).lastIndexOf('v1Post');
  const firstGetIdx = client.calls.findIndex((c, i) => c.fn === 'v1Get' && i > lastWriteIdx);
  check('1. verify GETs run after all writes', firstGetIdx > lastWriteIdx);
  check('1. verified.page/route/block/html_content/auth all true', result.verified.page === true && result.verified.route === true && result.verified.block === true && result.verified.html_content === true && result.verified.auth === true);

  // ---- body shapes ----
  const pagesPost = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'Pages');
  check('1. Pages body has InternalName/PageTitle/BrowserTitle from name', pagesPost.body.InternalName === 'Test Admin Page' && pagesPost.body.PageTitle === 'Test Admin Page' && pagesPost.body.BrowserTitle === 'Test Admin Page');
  check('1. Pages body has ParentPageId', pagesPost.body.ParentPageId === 1235);
  check('1. Pages body has default LayoutId (12)', pagesPost.body.LayoutId === 12);

  const routePost = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'PageRoutes');
  check('1. PageRoutes body has PageId + Route (no leading slash)', routePost.body.PageId === 5001 && routePost.body.Route === 'TestAdminPage');

  const blockPost = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'Blocks');
  check('1. Blocks body has PageId/BlockTypeId(default 6)/Zone(default Main)/Name(default=name)', blockPost.body.PageId === 5001 && blockPost.body.BlockTypeId === 6 && blockPost.body.Zone === 'Main' && blockPost.body.Name === 'Test Admin Page');

  const htmlPost = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'HtmlContents');
  check('1. HtmlContents body has BlockId/Content/Version:1/IsApproved:true', htmlPost.body.BlockId === 5003 && htmlPost.body.Content === '<div>hello</div>' && htmlPost.body.Version === 1 && htmlPost.body.IsApproved === true);

  const htmlPatch = client.calls.find((c) => c.fn === 'v1Patch' && c.path === 'HtmlContents/5004');
  check('1. HtmlContents PATCH carries ApprovedDateTime only', Object.keys(htmlPatch.body).sort().join(',') === 'ApprovedDateTime' && typeof htmlPatch.body.ApprovedDateTime === 'string' && htmlPatch.body.ApprovedDateTime.length > 0);

  const authPosts = client.calls.filter((c) => c.fn === 'v1Post' && c.path === 'Auths');
  check('1. exactly 3 Auths POSTs (2 allow + 1 deny)', authPosts.length === 3);
  check('1. allow[0]: GroupId 2, Order 0, Action View, AllowOrDeny A', authPosts[0].body.GroupId === 2 && authPosts[0].body.Order === 0 && authPosts[0].body.Action === 'View' && authPosts[0].body.AllowOrDeny === 'A');
  check('1. allow[1]: GroupId 3, Order 1, Action View, AllowOrDeny A', authPosts[1].body.GroupId === 3 && authPosts[1].body.Order === 1 && authPosts[1].body.Action === 'View' && authPosts[1].body.AllowOrDeny === 'A');
  check('1. deny: Order 2 (last), SpecialRole 1, AllowOrDeny D, Action View, NO GroupId', authPosts[2].body.Order === 2 && authPosts[2].body.SpecialRole === 1 && authPosts[2].body.AllowOrDeny === 'D' && authPosts[2].body.Action === 'View' && authPosts[2].body.GroupId === undefined);
  check('1. every Auth POST targets EntityTypeId 2 (Page) and EntityId = pageId', authPosts.every((a) => a.body.EntityTypeId === 2 && a.body.EntityId === 5001));

  // ---- route registration warning ----
  check('1. warnings include the PageRoute registration gotcha', result.warnings.some((w) => /route.*NOT.*register|will NOT register/i.test(w)));
  check('1. warnings include the /rock-build only-new-objects reminder', result.warnings.some((w) => /only NEW objects were touched/i.test(w)));

  // ---- ledger records: one per created object, correct entityType + newId ----
  const records = await readLedgerRecords();
  const forThisRun = records.filter((r) => r.tool === 'create_page_bundle');
  check('1. 7 ledger records written (page, route, block, htmlcontent, auth x3)', forThisRun.length === 7);
  check('1. all ledger records are phase:"create"', forThisRun.every((r) => r.phase === 'create'));
  const byEntityType = (t) => forThisRun.filter((r) => r.target.entityType === t);
  check('1. one Page ledger record, newId 5001', byEntityType('Page').length === 1 && byEntityType('Page')[0].result.newId === 5001);
  check('1. one PageRoute ledger record, newId 5002', byEntityType('PageRoute').length === 1 && byEntityType('PageRoute')[0].result.newId === 5002);
  check('1. one Block ledger record, newId 5003', byEntityType('Block').length === 1 && byEntityType('Block')[0].result.newId === 5003);
  check('1. one HtmlContent ledger record, newId 5004', byEntityType('HtmlContent').length === 1 && byEntityType('HtmlContent')[0].result.newId === 5004);
  check('1. three Auth ledger records, newIds 5010/5011/5012', byEntityType('Auth').length === 3 && byEntityType('Auth').map((r) => r.result.newId).sort((a, b) => a - b).join(',') === '5010,5011,5012');
  check('1. ledger payload.label uses label param ("Test Bundle — <object>")', forThisRun.every((r) => r.payload.label.startsWith('Test Bundle — ')));

  // ---- manifest entries per object ----
  const manifest = readManifest();
  check('1. manifest section "page-bundles" exists', !!manifest['page-bundles']);
  const section = manifest['page-bundles'] || {};
  check('1. manifest has -page/-route/-block/-htmlcontent/-auth-0/-auth-1/-auth-2 keys', ['page', 'route', 'block', 'htmlcontent', 'auth-0', 'auth-1', 'auth-2'].every((suffix) => `test-admin-page-${suffix}` in section));
  check('1. manifest page key value == 5001', section['test-admin-page-page'] === 5001);
}

// =========================================================================
// 2. No route → no PageRoutes call, no registration warning.
// =========================================================================
{
  const client = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 6001 };
      if (path === 'Blocks') return { Id: 6003 };
      if (path === 'HtmlContents') return { Id: 6004 };
      return undefined;
    },
  });
  const result = await createPageBundle(client, {
    name: 'No Route Page',
    parent_page_id: 20,
    content: '<p>x</p>',
  });
  check('2. success:true', result.success === true);
  check('2. no PageRoutes POST call', !client.calls.some((c) => c.fn === 'v1Post' && c.path === 'PageRoutes'));
  check('2. route_id is undefined', result.route_id === undefined);
  check('2. no route-registration warning', !result.warnings.some((w) => /register/i.test(w)));
  check('2. url_hint falls back to /page/{id}', result.url_hint === '/page/6001');
  check('2. no Auths calls (allow_role_ids omitted)', !client.calls.some((c) => c.fn === 'v1Post' && c.path === 'Auths'));
  check('2. auth_ids undefined', result.auth_ids === undefined);
  check('2. verified has no "route" key', !('route' in result.verified));
  check('2. verified has no "auth" key', !('auth' in result.verified));
}

// =========================================================================
// 3. no allow_role_ids → no Auth calls (route present this time, to isolate the auth axis).
// =========================================================================
{
  const client = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 7001 };
      if (path === 'PageRoutes') return { Id: 7002 };
      if (path === 'Blocks') return { Id: 7003 };
      if (path === 'HtmlContents') return { Id: 7004 };
      return undefined;
    },
  });
  const result = await createPageBundle(client, {
    name: 'Unlocked Page',
    parent_page_id: 21,
    content: '<p>y</p>',
    route: 'UnlockedPage',
  });
  check('3. success:true', result.success === true);
  check('3. no Auths calls', !client.calls.some((c) => c.fn === 'v1Post' && c.path === 'Auths'));
  check('3. auth_ids undefined', result.auth_ids === undefined);
  check('3. route registration warning still present (route WAS created)', result.warnings.some((w) => /will NOT register/i.test(w)));
}

// =========================================================================
// 4. Failure at Blocks POST → created_so_far has page(+route) only; no HtmlContents/Auth
//    calls ran; success:false; failed_step:'block'.
// =========================================================================
{
  const client = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 8001 };
      if (path === 'PageRoutes') return { Id: 8002 };
      if (path === 'Blocks') return { __throw__: 'Rock v1 POST Blocks → 500: simulated failure' };
      if (path === 'HtmlContents' || path === 'Auths') throw new Error('should not be called after Blocks failure');
      return undefined;
    },
  });
  const result = await createPageBundle(client, {
    name: 'Fails At Block',
    parent_page_id: 22,
    content: '<p>z</p>',
    route: 'FailsAtBlock',
    allow_role_ids: [2],
  });
  check('4. success:false', result.success === false);
  check('4. failed_step is "block"', result.failed_step === 'block');
  check('4. error message surfaced', /simulated failure/.test(result.error));
  check('4. created_so_far has exactly 2 entries (page, route)', Array.isArray(result.created_so_far) && result.created_so_far.length === 2);
  check('4. created_so_far[0] is page with id 8001', result.created_so_far[0].object === 'page' && result.created_so_far[0].id === 8001);
  check('4. created_so_far[1] is route with id 8002', result.created_so_far[1].object === 'route' && result.created_so_far[1].id === 8002);
  check('4. created_so_far entries carry auditId', result.created_so_far.every((c) => typeof c.auditId === 'string' && c.auditId.length > 0));
  check('4. undo_hint mentions rock_restore + auditId', /rock_restore/.test(result.undo_hint) && /auditId/.test(result.undo_hint));
  check('4. NO HtmlContents call ran', !client.calls.some((c) => c.path === 'HtmlContents' || c.path === 'HtmlContents/8001'));
  check('4. NO Auths call ran', !client.calls.some((c) => c.path === 'Auths'));
  check('4. NO verify GETs ran (failure short-circuits before step 6)', !client.calls.some((c) => c.fn === 'v1Get' && !['BlockTypes','EntityTypes'].includes(c.path) && !/^Pages\/\d+$/.test(c.path)));

  // Only 2 ledger records for this failed run (page, route) — Blocks itself never got ledgered.
  const records = await readLedgerRecords();
  const thisRun = records.filter((r) => r.payload && r.payload.label && r.payload.label.startsWith('Fails At Block —'));
  check('4. exactly 2 ledger records for the failed run (page, route — block never ledgered)', thisRun.length === 2);
}

// =========================================================================
// 5. Failure at HtmlContents PATCH (the ApprovedDateTime flush) → failed_step
//    'html_content_flush', but the row was POSTed and EXISTS in Rock, so it MUST be
//    ledgered + in created_so_far (ledger truthfulness: record what happened, not only
//    what completed cleanly — an unflushed row is real, just cache-stale, never an
//    invisible orphan). The hint tells the operator how to recover either way.
// =========================================================================
{
  const client = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 8101 };
      if (path === 'Blocks') return { Id: 8103 };
      if (path === 'HtmlContents') return { Id: 8104 };
      if (path === 'Auths') throw new Error('should not be called after flush failure');
      return undefined;
    },
    v1Patch(path) {
      if (path === 'HtmlContents/8104') return { __throw__: 'Rock v1 PATCH HtmlContents/8104 → 500: flush failed' };
      return undefined;
    },
  });
  const result = await createPageBundle(client, {
    name: 'Fails At Flush',
    parent_page_id: 23,
    content: '<p>flush-fail</p>',
    allow_role_ids: [2],
  });
  check('5. success:false', result.success === false);
  check('5. failed_step is "html_content_flush"', result.failed_step === 'html_content_flush');
  check('5. created_so_far INCLUDES the html row (page, block, htmlcontent — it exists in Rock)', result.created_so_far.map((c) => c.object).join(',') === 'page,block,htmlcontent');
  const htmlEntry = result.created_so_far.find((c) => c.object === 'htmlcontent');
  check('5. htmlcontent entry has id 8104 and a real auditId', htmlEntry && htmlEntry.id === 8104 && typeof htmlEntry.auditId === 'string' && htmlEntry.auditId.length > 0);
  check('5. hint names flush_cache (target htmlcontent) and rock_restore', typeof result.hint === 'string' && /flush_cache/.test(result.hint) && /htmlcontent/.test(result.hint) && /rock_restore/.test(result.hint));
  check('5. NO Auths call ran', !client.calls.some((c) => c.path === 'Auths'));

  // The temp ledger contains the html row's phase-'create' record — undoable via rock_restore.
  const records = await readLedgerRecords();
  const htmlRec = records.find((r) => r.tool === 'create_page_bundle' && r.target.entityType === 'HtmlContent' && r.result.newId === 8104);
  check('5. ledger has the phase-"create" HtmlContent record for the flush-failed row', !!htmlRec && htmlRec.phase === 'create');
  check('5. created_so_far htmlcontent auditId matches the ledger record', !!htmlRec && htmlEntry.auditId === htmlRec.auditId);
}

// =========================================================================
// 6. Param validation.
// =========================================================================
await checkThrows('6a. missing name throws', () => createPageBundle(makeMockClient(), { parent_page_id: 1, content: 'x' }), /name is required/i);
await checkThrows('6b. empty name throws', () => createPageBundle(makeMockClient(), { name: '   ', parent_page_id: 1, content: 'x' }), /name is required/i);
await checkThrows('6c. missing parent_page_id throws', () => createPageBundle(makeMockClient(), { name: 'X', content: 'x' }), /parent_page_id must be a finite number/i);
await checkThrows('6d. non-finite parent_page_id throws', () => createPageBundle(makeMockClient(), { name: 'X', parent_page_id: NaN, content: 'x' }), /parent_page_id must be a finite number/i);
await checkThrows('6e. missing content throws', () => createPageBundle(makeMockClient(), { name: 'X', parent_page_id: 1 }), /content is required/i);
await checkThrows('6f. bad allow_role_ids element throws', () => createPageBundle(makeMockClient(), { name: 'X', parent_page_id: 1, content: 'x', allow_role_ids: [2, 'nope'] }), /allow_role_ids must all be finite numbers/i);
await checkThrows('6g. allow_role_ids not an array throws', () => createPageBundle(makeMockClient(), { name: 'X', parent_page_id: 1, content: 'x', allow_role_ids: 2 }), /allow_role_ids must be an array/i);
await checkThrows('6h. non-finite layout_id throws', () => createPageBundle(makeMockClient(), { name: 'X', parent_page_id: 1, content: 'x', layout_id: NaN }), /layout_id must be a finite number/i);
await checkThrows('6i. non-finite block_type_id throws', () => createPageBundle(makeMockClient(), { name: 'X', parent_page_id: 1, content: 'x', block_type_id: Infinity }), /block_type_id must be a finite number/i);

// =========================================================================
// 7. Route leading-slash normalization.
// =========================================================================
{
  const client = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 9001 };
      if (path === 'PageRoutes') return { Id: 9002 };
      if (path === 'Blocks') return { Id: 9003 };
      if (path === 'HtmlContents') return { Id: 9004 };
      return undefined;
    },
  });
  const result = await createPageBundle(client, {
    name: 'Slash Route Page',
    parent_page_id: 24,
    content: '<p>slash</p>',
    route: '/LeadingSlashRoute',
  });
  const routePost = client.calls.find((c) => c.fn === 'v1Post' && c.path === 'PageRoutes');
  check('7a. leading slash stripped from Route body', routePost.body.Route === 'LeadingSlashRoute');
  check('7b. url_hint uses the stripped route (single leading slash, not doubled)', result.url_hint === '/LeadingSlashRoute');
  check('7c. warnings mention the leading-slash strip', result.warnings.some((w) => /leading slash/i.test(w)));
}

// =========================================================================
// 8. url_hint correctness both with and without route (already covered above by tests
//    1/2/7, but assert explicitly together here for a single focused checkpoint).
// =========================================================================
{
  const withRouteClient = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 9101 };
      if (path === 'PageRoutes') return { Id: 9102 };
      if (path === 'Blocks') return { Id: 9103 };
      if (path === 'HtmlContents') return { Id: 9104 };
      return undefined;
    },
  });
  const withRoute = await createPageBundle(withRouteClient, { name: 'URL Hint With Route', parent_page_id: 25, content: '<p>a</p>', route: 'UrlHintRoute' });
  check('8a. url_hint = "/<route>" when route present', withRoute.url_hint === '/UrlHintRoute');

  const withoutRouteClient = makeMockClient({
    v1Post(path) {
      if (path === 'Pages') return { Id: 9201 };
      if (path === 'Blocks') return { Id: 9203 };
      if (path === 'HtmlContents') return { Id: 9204 };
      return undefined;
    },
  });
  const withoutRoute = await createPageBundle(withoutRouteClient, { name: 'URL Hint No Route', parent_page_id: 26, content: '<p>b</p>' });
  check('8b. url_hint = "/page/<id>" when no route', withoutRoute.url_hint === '/page/9201');
}

// =========================================================================
// 9. site_id is NOT a parameter — dropped entirely (an accepted-but-silently-unused
//    param is a footgun: a caller passing site_id:3 would believe they targeted a site
//    with no signal otherwise). The layout determines the site; neither proven build
//    source sends a site field on the Pages POST.
// =========================================================================
check('9a. inputSchema.properties has NO site_id', !('site_id' in createPageBundleSchema.inputSchema.properties));
check('9b. layout_id description says the layout determines the site (Page has no SiteId field)', /layout determines the site/i.test(createPageBundleSchema.inputSchema.properties.layout_id.description) && /no SiteId field/i.test(createPageBundleSchema.inputSchema.properties.layout_id.description));

// =========================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('Failures: ' + failures.join(', '));

// Best-effort cleanup — never touches the real repo's logs/ dir since scratch is under tmpdir().
try { rmSync(scratch, { recursive: true, force: true }); } catch {}

process.exit(fail ? 1 : 0);
