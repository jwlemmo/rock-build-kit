#!/usr/bin/env node
// Pure-unit tests for edit_block_content (no network) — preview/execute two-phase
// handshake, all four operations (replace/insert_before/insert_after/full_replace),
// exact-count refusals, base-sha drift, token tamper, verify-FAILED path, trailing-
// whitespace warning, ledger record shapes, block_id fallback refusal, and restore-
// compat against rock-restore's classifyRestore.
//
// IMPORTANT: ROCK_LOGS_DIR must be set BEFORE the safety/audit.ts and safety/manifest.ts
// modules are first imported — LOGS_DIR/AUDIT_FILE/SNAPSHOT_DIR are bound as module-level
// consts evaluated at import time. Every dist module in the audit-ledger transitive
// closure (block-content.js, rock-restore.js, safety/index.js, safety/audit.js,
// safety/ledger.js) is therefore loaded via a dynamic `await import(...)` AFTER the env
// var is set — same pattern as test/verify-restore.mjs.
//
// This test NEVER touches the real logs/ directory: ROCK_LOGS_DIR points at a scratch
// temp dir created fresh for this run and removed at the end (best-effort).
//
// Run: node test/verify-blockedit.mjs

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const scratch = mkdtempSync(join(tmpdir(), 'rock-blockedit-test-'));
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
function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---- Mock RockClient: records every call, returns canned responses keyed by fn+path(+filter) ----
function makeMockClient(responses = {}) {
  const calls = [];
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
        if (v && typeof v === 'object' && v.__throw__) throw new Error(v.__throw__);
        return v;
      }
      throw new Error(`Rock v1 GET ${path}${filterSuffix} → 404: not found (unmocked: ${key})`);
    },
    async v1Post(path, body) {
      calls.push({ fn: 'v1Post', path, body });
      const key = `v1Post:${path}`;
      if (key in responses) return responses[key];
      return { Id: 999 };
    },
    async v1Patch(path, body) {
      calls.push({ fn: 'v1Patch', path, body });
      // After a PATCH, subsequent v1Get for the same path should reflect the new Content —
      // tests configure this via a mutable `state` object closed over per-scenario below.
      return undefined;
    },
    async v1Delete(path) {
      calls.push({ fn: 'v1Delete', path });
      return undefined;
    },
    async executeSql(sql) {
      calls.push({ fn: 'executeSql', sql });
      return [];
    },
    async executeSqlCommand(sql) {
      calls.push({ fn: 'executeSqlCommand', sql });
      return 1;
    },
  };
  return client;
}

/** A row-backed mock: v1Get always returns the CURRENT state of `row` (mutated by test-driven
 * PATCH simulation), so preview→confirm sequences against the same client see a consistent
 * before/after. Tests that need to simulate a mid-handshake drift replace row.Content directly
 * between the preview and confirm calls. */
function makeRowClient(row, overrides = {}) {
  const calls = [];
  let current = { ...row };
  const client = {
    calls,
    _setContent(c) { current = { ...current, Content: c }; },
    _getRow() { return { ...current }; },
    async v1Get(path, params) {
      calls.push({ fn: 'v1Get', path, params });
      if (overrides.v1Get) {
        const r = overrides.v1Get(path, params, current);
        if (r !== undefined) return r;
      }
      if (path === `HtmlContents/${current.Id}`) return { ...current };
      const filterSuffix = params && params.$filter ? `?$filter=${params.$filter}` : '';
      const key = `v1Get:${path}${filterSuffix}`;
      throw new Error(`Rock v1 GET ${path}${filterSuffix} → 404: not found (unmocked: ${key})`);
    },
    async v1Post(path, body) {
      calls.push({ fn: 'v1Post', path, body });
      return { Id: 999 };
    },
    async v1Patch(path, body) {
      calls.push({ fn: 'v1Patch', path, body });
      if (path === `HtmlContents/${current.Id}`) {
        current = { ...current, ...body };
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

console.log('\n== edit_block_content unit tests (offline) ==\n');

// ---- Dynamic imports AFTER env var is set (see header comment) ----
const { editBlockContent } = await import('../dist/tools/block-content.js');
const { classifyRestore } = await import('../dist/tools/rock-restore.js');
const { AUDIT_FILE, SNAPSHOT_DIR } = await import('../dist/safety/audit.js');
const { readLedgerRecords } = await import('../dist/safety/ledger.js');

check('audit.ts AUDIT_FILE resolved under scratch dir', AUDIT_FILE.startsWith(scratch));
check('audit.ts SNAPSHOT_DIR resolved under scratch dir', SNAPSHOT_DIR.startsWith(scratch));

const PAST = new Date(Date.now() - 86400000).toISOString();

// =========================================================================
// 1. replace happy path E2E — preview → confirm → PATCH body matches
//    deploy.mjs-style {Content, ApprovedDateTime} sequence → after-GET verify
//    passes → executed ledger record shape correct.
// =========================================================================
let replaceToken, replaceBaseSha;
{
  const baseContent = '<p>Hello world, this needs fixing.</p>\n  \n';
  const client = makeRowClient({
    Id: 4001, BlockId: 500, Content: baseContent, Version: 3, IsApproved: true,
    ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'rep-1', CreatedDateTime: PAST, ModifiedDateTime: PAST,
  });

  const preview = await editBlockContent(client, {
    html_content_id: 4001, operation: 'replace', old_string: 'fixing', new_string: 'improving',
  });
  check('1a. preview phase returned', preview.phase === 'preview');
  check('1a. preview base_sha256 matches sha256(base content)', preview.base_sha256 === sha256(baseContent));
  const expectedNew = baseContent.split('fixing').join('improving');
  check('1a. preview new_sha256 matches sha256(computed new content)', preview.new_sha256 === sha256(expectedNew));
  check('1a. preview length_chars_before/after correct', preview.length_chars_before === baseContent.length && preview.length_chars_after === expectedNew.length);
  check('1a. preview did not write (no v1Patch call)', !client.calls.some((c) => c.fn === 'v1Patch'));
  check('1a. preview includes confirmation_token', typeof preview.confirmation_token === 'string' && preview.confirmation_token.length > 0);
  check('1a. preview includes context_excerpts (at least 1, at most 3)', Array.isArray(preview.context_excerpts) && preview.context_excerpts.length >= 1 && preview.context_excerpts.length <= 3);
  check('1a. preview context excerpt contains the matched old_string', preview.context_excerpts.some((e) => e.includes('fixing')));
  check('1a. preview cache_note mentions ApprovedDateTime', /ApprovedDateTime/.test(preview.cache_note));
  check('1a. preview next_step is STOP text', /^STOP\./.test(preview.next_step));
  check('1a. no trailing-whitespace warning (delta is 0 here)', preview.warning === undefined);
  replaceToken = preview.confirmation_token;
  replaceBaseSha = preview.base_sha256;

  // Preview ledger record has NO full content.
  const recordsAfterPreview = await readLedgerRecords();
  const previewRec = recordsAfterPreview.find((r) => r.phase === 'preview' && r.target.id === 4001);
  check('1b. preview ledger record exists', !!previewRec);
  check('1b. preview ledger record tool is edit_block_content', previewRec && previewRec.tool === 'edit_block_content');
  check('1b. preview ledger payload has NO body/content field', previewRec && previewRec.payload.body === undefined && previewRec.payload.content === undefined);
  check('1b. preview ledger payload carries baseSha/newSha (not raw strings)', previewRec && previewRec.payload.baseSha === sha256(baseContent) && previewRec.payload.newSha === sha256(expectedNew));
  check('1b. preview ledger payload does NOT carry raw old_string/new_string', previewRec && JSON.stringify(previewRec.payload).indexOf('fixing') === -1 && JSON.stringify(previewRec.payload).indexOf('improving') === -1);

  // Confirm.
  const result = await editBlockContent(client, {
    html_content_id: 4001, operation: 'replace', old_string: 'fixing', new_string: 'improving',
    confirmation_token: replaceToken, base_sha256: replaceBaseSha,
  });
  check('1c. execute phase returned', result.phase === 'executed');
  check('1c. execute reports success', result.success === true);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('1c. execute PATCHed HtmlContents/4001', !!patchCall && patchCall.path === 'HtmlContents/4001');
  check('1c. PATCH body carries the computed Content (byte-exact)', patchCall.body.Content === expectedNew);
  check('1c. PATCH body carries ApprovedDateTime (the proven cache-flush field)', typeof patchCall.body.ApprovedDateTime === 'string' && patchCall.body.ApprovedDateTime.length > 0);
  check('1c. PATCH body is EXACTLY {Content, ApprovedDateTime} — no stray fields', Object.keys(patchCall.body).sort().join(',') === 'ApprovedDateTime,Content');
  check('1c. after-GET verify passed (before/after sha reported)', result.before_sha256 === sha256(baseContent) && result.after_sha256 === sha256(expectedNew));
  check('1c. cache_flushed:true reported', result.cache_flushed === true);
  check('1c. cache_flush_mechanism mentions FlushCachedContent', /FlushCachedContent/.test(result.cache_flush_mechanism));
  check('1c. length_delta_chars correct', result.length_delta_chars === expectedNew.length - baseContent.length);
  check('1c. before_snapshot_ref returned', typeof result.before_snapshot_ref === 'string');

  // Executed ledger record shape.
  const recordsAfterExec = await readLedgerRecords();
  const execRec = recordsAfterExec.find((r) => r.phase === 'executed' && r.auditId === result.auditId);
  check('1d. executed ledger record exists', !!execRec);
  check('1d. executed ledger record tool is edit_block_content', execRec && execRec.tool === 'edit_block_content');
  check('1d. executed ledger record verb/mode are edit/rest', execRec && execRec.verb === 'edit' && execRec.mode === 'rest');
  check('1d. executed ledger target is HtmlContent #4001', execRec && execRec.target.entityType === 'HtmlContent' && execRec.target.id === 4001);
  check('1d. executed ledger payload.body.Content is the FULL new content', execRec && execRec.payload.body.Content === expectedNew);
  check('1d. executed ledger payload.body.ApprovedDateTime present', execRec && typeof execRec.payload.body.ApprovedDateTime === 'string');
  check('1d. executed ledger payload carries operation summary + baseSha/newSha', execRec && execRec.payload.operation === 'replace' && execRec.payload.baseSha === sha256(baseContent) && execRec.payload.newSha === sha256(expectedNew));
  check('1d. executed ledger record has a snapshotRef', execRec && typeof execRec.snapshotRef === 'string');
}

// =========================================================================
// 2. Multi-match refusal reports the actual count
// =========================================================================
await checkThrows(
  '2. replace with old_string occurring 3 times (expected default 1) refuses reporting 3',
  async () => editBlockContent(
    makeRowClient({ Id: 4002, BlockId: 501, Content: 'aXaXaX', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g', CreatedDateTime: PAST, ModifiedDateTime: PAST }),
    { html_content_id: 4002, operation: 'replace', old_string: 'X', new_string: 'Y' }
  ),
  /occurs 3 time\(s\).*not the expected 1/i
);

// =========================================================================
// 3. expected_count=2 works (matches the actual count of 2)
// =========================================================================
{
  const content = 'foo bar foo';
  const client = makeRowClient({ Id: 4003, BlockId: 502, Content: content, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g3', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4003, operation: 'replace', old_string: 'foo', new_string: 'baz', expected_count: 2 });
  check('3. expected_count:2 matches actual count of 2 → preview succeeds', preview.phase === 'preview');
  check('3. new content replaces BOTH occurrences', preview.new_sha256 === sha256('baz bar baz'));
}
await checkThrows(
  '3b. expected_count mismatch (declared 5, actual 2) refuses reporting actual count',
  async () => editBlockContent(
    makeRowClient({ Id: 4003, BlockId: 502, Content: 'foo bar foo', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g3', CreatedDateTime: PAST, ModifiedDateTime: PAST }),
    { html_content_id: 4003, operation: 'replace', old_string: 'foo', new_string: 'baz', expected_count: 5 }
  ),
  /occurs 2 time\(s\).*not the expected 5/i
);

// =========================================================================
// 4. anchor not-found / ambiguous refusals (insert_before / insert_after)
// =========================================================================
await checkThrows(
  '4a. insert_before anchor not found (0 occurrences) refuses reporting 0',
  async () => editBlockContent(
    makeRowClient({ Id: 4004, BlockId: 503, Content: '<div>no marker here</div>', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g4', CreatedDateTime: PAST, ModifiedDateTime: PAST }),
    { html_content_id: 4004, operation: 'insert_before', anchor: '<!--MARKER-->', text: 'x' }
  ),
  /occurs 0 time\(s\).*requires exactly 1/i
);
await checkThrows(
  '4b. insert_after anchor ambiguous (2 occurrences) refuses reporting 2',
  async () => editBlockContent(
    makeRowClient({ Id: 4005, BlockId: 504, Content: '<hr/><hr/>', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g5', CreatedDateTime: PAST, ModifiedDateTime: PAST }),
    { html_content_id: 4005, operation: 'insert_after', anchor: '<hr/>', text: 'x' }
  ),
  /occurs 2 time\(s\).*requires exactly 1/i
);

// insert_before/insert_after happy path (also exercises excerpt + splice correctness)
{
  const content = '<body><!--HOOK--></body>';
  const client = makeRowClient({ Id: 4006, BlockId: 505, Content: content, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g6', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const previewBefore = await editBlockContent(client, { html_content_id: 4006, operation: 'insert_before', anchor: '<!--HOOK-->', text: 'INSERTED-' });
  check('4c. insert_before splices immediately before the anchor', previewBefore.new_sha256 === sha256('<body>INSERTED-<!--HOOK--></body>'));
  const previewAfter = await editBlockContent(client, { html_content_id: 4006, operation: 'insert_after', anchor: '<!--HOOK-->', text: '-INSERTED' });
  check('4d. insert_after splices immediately after the anchor', previewAfter.new_sha256 === sha256('<body><!--HOOK-->-INSERTED</body>'));
}

// =========================================================================
// 5. full_replace declared-sha mismatch refusal
// =========================================================================
await checkThrows(
  '5a. full_replace with a wrong declared_sha256 refuses',
  async () => editBlockContent(
    makeRowClient({ Id: 4007, BlockId: 506, Content: 'old', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g7', CreatedDateTime: PAST, ModifiedDateTime: PAST }),
    { html_content_id: 4007, operation: 'full_replace', content: 'brand new content', declared_sha256: sha256('something else entirely') }
  ),
  /does not match declared_sha256/i
);

// =========================================================================
// 6. full_replace happy path (preview + confirm)
// =========================================================================
let fullReplaceToken, fullReplaceBaseSha;
{
  const baseContent = 'old full content';
  const newContent = 'brand new full content, byte-exact';
  const client = makeRowClient({ Id: 4008, BlockId: 507, Content: baseContent, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g8', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4008, operation: 'full_replace', content: newContent, declared_sha256: sha256(newContent) });
  check('6a. full_replace preview phase returned', preview.phase === 'preview');
  check('6a. full_replace preview new_sha256 matches the declared/actual sha', preview.new_sha256 === sha256(newContent));
  fullReplaceToken = preview.confirmation_token;
  fullReplaceBaseSha = preview.base_sha256;

  const result = await editBlockContent(client, {
    html_content_id: 4008, operation: 'full_replace', content: newContent, declared_sha256: sha256(newContent),
    confirmation_token: fullReplaceToken, base_sha256: fullReplaceBaseSha,
  });
  check('6b. full_replace execute phase returned', result.phase === 'executed');
  check('6b. full_replace execute reports success', result.success === true);
  const patchCall = client.calls.find((c) => c.fn === 'v1Patch');
  check('6b. full_replace PATCH Content matches the new content byte-exactly', patchCall && patchCall.body.Content === newContent);
}

// =========================================================================
// 7. base-sha drift at confirm → clean refusal BEFORE token check, no write issued
// =========================================================================
{
  const baseContent = 'drift base content';
  const client = makeRowClient({ Id: 4009, BlockId: 508, Content: baseContent, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g9', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4009, operation: 'replace', old_string: 'drift', new_string: 'shifted' });
  const validToken = preview.confirmation_token;
  const validBaseSha = preview.base_sha256;

  // Someone else edits the row between preview and confirm.
  client._setContent('SOMEONE ELSE CHANGED THIS drift base content');

  await checkThrows(
    '7. base-sha drift at confirm is refused with a clean "content changed" message (not token mismatch)',
    async () => editBlockContent(client, {
      html_content_id: 4009, operation: 'replace', old_string: 'drift', new_string: 'shifted',
      confirmation_token: validToken, base_sha256: validBaseSha,
    }),
    /content changed since the preview/i
  );
  check('7. drift refusal issued NO write (no v1Patch call after the drift)', !client.calls.some((c) => c.fn === 'v1Patch'));
}

// missing base_sha256 entirely on confirm call
await checkThrows(
  '7b. confirm call missing base_sha256 entirely is refused',
  async () => {
    const client = makeRowClient({ Id: 4010, BlockId: 509, Content: 'x', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g10', CreatedDateTime: PAST, ModifiedDateTime: PAST });
    return editBlockContent(client, { html_content_id: 4010, operation: 'replace', old_string: 'x', new_string: 'y', confirmation_token: 'whatever' });
  },
  /base_sha256 is required/i
);

// =========================================================================
// 8. Token tamper rejected
// =========================================================================
{
  const client = makeRowClient({ Id: 4011, BlockId: 510, Content: 'tamper test content', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g11', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4011, operation: 'replace', old_string: 'tamper', new_string: 'fixed' });
  const tamperedToken = preview.confirmation_token.slice(0, -4) + 'zzzz';
  await checkThrows(
    '8. tampered confirmation_token rejected',
    async () => editBlockContent(client, {
      html_content_id: 4011, operation: 'replace', old_string: 'tamper', new_string: 'fixed',
      confirmation_token: tamperedToken, base_sha256: preview.base_sha256,
    }),
    /mismatch/i
  );
  check('8b. tampered-token confirm issued no write', !client.calls.some((c) => c.fn === 'v1Patch'));
}

// changed-args token rejected (different new_string than what was previewed, same token)
{
  const client = makeRowClient({ Id: 4012, BlockId: 511, Content: 'change args content', Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g12', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4012, operation: 'replace', old_string: 'change', new_string: 'altered' });
  await checkThrows(
    '8c. confirm call with DIFFERENT new_string than previewed (same token) rejected',
    async () => editBlockContent(client, {
      html_content_id: 4012, operation: 'replace', old_string: 'change', new_string: 'DIFFERENT-VALUE',
      confirmation_token: preview.confirmation_token, base_sha256: preview.base_sha256,
    }),
    /mismatch/i
  );
}

// =========================================================================
// 9. verify-FAILED path — mock after-GET returns wrong content
// =========================================================================
{
  const baseContent = 'verify test content';
  const client = makeRowClient({ Id: 4013, BlockId: 512, Content: baseContent, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g13', CreatedDateTime: PAST, ModifiedDateTime: PAST }, {
    v1Get(path, params, current) {
      // Force the AFTER-write GET (i.e. once Content has already been PATCHed away from
      // baseContent) to return something that does NOT match what was just written —
      // simulating a mangled/partial write.
      if (path === `HtmlContents/${current.Id}` && current.Content !== baseContent) {
        return { ...current, Content: 'THIS IS NOT WHAT WAS WRITTEN' };
      }
      return undefined;
    },
  });
  const preview = await editBlockContent(client, { html_content_id: 4013, operation: 'replace', old_string: 'verify', new_string: 'confirmed' });
  const result = await editBlockContent(client, {
    html_content_id: 4013, operation: 'replace', old_string: 'verify', new_string: 'confirmed',
    confirmation_token: preview.confirmation_token, base_sha256: preview.base_sha256,
  });
  check('9. verify-FAILED: success is false', result.success === false);
  check('9. verify-FAILED: verify field is "FAILED"', result.verify === 'FAILED');
  check('9. verify-FAILED: expected_sha256 and actual_sha256 both present and differ', result.expected_sha256 && result.actual_sha256 && result.expected_sha256 !== result.actual_sha256);
  check('9. verify-FAILED: before_snapshot_ref present (snapshot was still written)', typeof result.before_snapshot_ref === 'string');
  check('9. verify-FAILED: warning tells caller to inspect, not retry', /do NOT/i.test(result.warning) || /inspect/i.test(result.warning));
  // No auto-retry means exactly ONE v1Patch call total across preview+confirm.
  const patchCalls = client.calls.filter((c) => c.fn === 'v1Patch');
  check('9. verify-FAILED path issued exactly ONE v1Patch call (no auto-retry)', patchCalls.length === 1);
}

// =========================================================================
// 10. Trailing-whitespace-loss warning fires (the 61-byte failure mode)
// =========================================================================
{
  const baseContent = 'body content here   \n\n  ';
  const newContentNoTrailing = 'body content here NEW';
  const client = makeRowClient({ Id: 4014, BlockId: 513, Content: baseContent, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g14', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4014, operation: 'full_replace', content: newContentNoTrailing, declared_sha256: sha256(newContentNoTrailing) });
  check('10. trailing-whitespace LOSS triggers a warning', typeof preview.warning === 'string' && preview.warning.length > 0);
  check('10. warning explicitly mentions trailing whitespace decreasing', /trailing whitespace.*DECREASING|DECREASING.*trailing whitespace/i.test(preview.warning));
  check('10. trailing_whitespace_chars_before/after reflect the actual loss', preview.trailing_whitespace_chars_before > preview.trailing_whitespace_chars_after);
}
// Sanity: no warning fires when trailing whitespace does not decrease.
{
  const baseContent = 'no trailing loss here';
  const newContent = 'no trailing loss here EDITED';
  const client = makeRowClient({ Id: 4015, BlockId: 514, Content: baseContent, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g15', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4015, operation: 'full_replace', content: newContent, declared_sha256: sha256(newContent) });
  check('10b. no trailing-whitespace warning when delta is not negative', preview.warning === undefined);
}

// =========================================================================
// 11. block_id refusal when only a fallback row exists (no active version)
// =========================================================================
await checkThrows(
  '11a. block_id with nothing approved/in-window refuses (no silent fallback)',
  async () => {
    const client = makeMockClient({
      'v1Get:HtmlContents?$filter=BlockId eq 600': [
        { Id: 601, BlockId: 600, Content: '<p>unapproved draft</p>', Version: 1, IsApproved: false,
          ApprovedDateTime: null, ApprovedByPersonAliasId: null, EntityValue: null,
          StartDateTime: null, ExpireDateTime: null, Guid: 'fb1', CreatedDateTime: PAST, ModifiedDateTime: PAST },
      ],
    });
    return editBlockContent(client, { block_id: 600, operation: 'replace', old_string: 'unapproved', new_string: 'x' });
  },
  /no HtmlContent row for block_id 600 currently satisfies the active-version rule.*pass html_content_id explicitly/i
);
await checkThrows(
  '11b. block_id with only context-specific rows (no default row at all) refuses',
  async () => {
    const client = makeMockClient({
      'v1Get:HtmlContents?$filter=BlockId eq 601': [
        { Id: 701, BlockId: 601, Content: '<p>context only</p>', Version: 1, IsApproved: true,
          ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: '42',
          StartDateTime: null, ExpireDateTime: null, Guid: 'fb2', CreatedDateTime: PAST, ModifiedDateTime: PAST },
      ],
    });
    return editBlockContent(client, { block_id: 601, operation: 'replace', old_string: 'context', new_string: 'x' });
  },
  /only context-specific HtmlContent rows.*pass html_content_id explicitly/i
);
// Sanity: block_id DOES resolve and succeed when an active row exists.
{
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 602': [
      { Id: 801, BlockId: 602, Content: '<p>active winner</p>', Version: 2, IsApproved: true,
        ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null,
        StartDateTime: null, ExpireDateTime: null, Guid: 'ok1', CreatedDateTime: PAST, ModifiedDateTime: PAST },
    ],
  });
  const preview = await editBlockContent(client, { block_id: 602, operation: 'replace', old_string: 'active', new_string: 'chosen' });
  check('11c. block_id WITH a valid active row resolves and previews successfully', preview.phase === 'preview' && preview.id === 801);
}

// =========================================================================
// 12. IsApproved:false warning on the target row
// =========================================================================
{
  const client = makeRowClient({ Id: 4016, BlockId: 515, Content: 'unapproved row content', Version: 1, IsApproved: false, ApprovedDateTime: null, ApprovedByPersonAliasId: null, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'g16', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4016, operation: 'replace', old_string: 'unapproved', new_string: 'approved' });
  check('12. preview warns when target row IsApproved is false', typeof preview.warning === 'string' && /IsApproved:false/.test(preview.warning));
  check('12. preview reports is_approved:false', preview.is_approved === false);
}

// =========================================================================
// 13. Restore-compat — classifyRestore over our executed record yields a
//     patch-back plan whose body restores the before Content.
// =========================================================================
{
  const baseContent = '<p>Lava before restore-compat check</p>';
  const client = makeRowClient({ Id: 4017, BlockId: 516, Content: baseContent, Version: 1, IsApproved: true, ApprovedDateTime: PAST, ApprovedByPersonAliasId: 5, EntityValue: null, StartDateTime: null, ExpireDateTime: null, Guid: 'restore-compat-1', CreatedDateTime: PAST, ModifiedDateTime: PAST });
  const preview = await editBlockContent(client, { html_content_id: 4017, operation: 'replace', old_string: 'before', new_string: 'AFTER' });
  const result = await editBlockContent(client, {
    html_content_id: 4017, operation: 'replace', old_string: 'before', new_string: 'AFTER',
    confirmation_token: preview.confirmation_token, base_sha256: preview.base_sha256,
  });
  check('13a. edit executed cleanly (precondition for the restore-compat check)', result.phase === 'executed' && result.success === true);

  const allRecords = await readLedgerRecords();
  const execRec = allRecords.find((r) => r.phase === 'executed' && r.auditId === result.auditId);
  check('13b. found the executed ledger record to classify', !!execRec);

  const plan = await classifyRestore(execRec);
  check('13c. classifyRestore does NOT refuse this record', plan.kind !== 'refuse' && plan.kind !== 'sql-refuse');
  check('13d. classifyRestore yields a patch-back plan (case c)', plan.kind === 'patch-back');
  check('13e. patch-back plan targets HtmlContents/4017', plan.kind === 'patch-back' && plan.controller === 'HtmlContents' && plan.id === 4017);
  check(
    '13f. patch-back plan body restores Content to the BEFORE value from the snapshot',
    plan.kind === 'patch-back' && plan.body.Content === baseContent
  );
  check(
    '13g. patch-back plan body ALSO restores ApprovedDateTime from the snapshot (payload.body key set == restore key set)',
    plan.kind === 'patch-back' && Object.prototype.hasOwnProperty.call(plan.body, 'ApprovedDateTime')
  );
}

// =====================================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('Failures: ' + failures.join(', '));

// Best-effort cleanup — never touches the real repo's logs/ dir since scratch is under tmpdir().
try { rmSync(scratch, { recursive: true, force: true }); } catch {}

process.exit(fail ? 1 : 0);
