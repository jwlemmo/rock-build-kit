#!/usr/bin/env node
// Pure-unit tests for get_block_content (no network) — param validation, active-version
// selection, context-row exclusion, no-active fallback, byte-fidelity stats (sha256,
// lengths, trailing whitespace), all_versions content inclusion, html_content_id direct
// mode, and Block-row/no-rows error handling.
//
// Run: node test/verify-blockcontent.mjs

import { getBlockContent } from '../dist/tools/block-content.js';

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

// ---- Mock RockClient: records every call, returns canned responses keyed by fn+path(+params) ----
// v1Get responses are keyed as `v1Get:<path>` for no-param calls, or `v1Get:<path>?<filter>`
// when a $filter is passed (mirrors how RockClient.qs() would serialize it onto the URL, but
// we only need the $filter value here — this tool never uses other v1Get query params).
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
        if (v === '__404__') throw new Error(`Rock v1 GET ${path} → 404: not found`);
        if (v && typeof v === 'object' && v.__throw__) throw new Error(v.__throw__);
        return v;
      }
      throw new Error(`Rock v1 GET ${path}${filterSuffix} → 404: not found (unmocked: ${key})`);
    },
  };
  return client;
}

console.log('\n== get_block_content unit tests (offline) ==\n');

// =========================================================================
// 1. Param validation — neither / both ids
// =========================================================================
await checkThrows(
  'neither block_id nor html_content_id → clear error',
  async () => getBlockContent(makeMockClient(), {}),
  /exactly one of block_id or html_content_id/i
);
await checkThrows(
  'both block_id and html_content_id → clear error',
  async () => getBlockContent(makeMockClient(), { block_id: 1, html_content_id: 2 }),
  /exactly one of block_id or html_content_id/i
);
await checkThrows(
  'non-finite block_id rejected',
  async () => getBlockContent(makeMockClient(), { block_id: NaN }),
  /finite number/i
);
await checkThrows(
  'non-finite html_content_id rejected',
  async () => getBlockContent(makeMockClient(), { html_content_id: Infinity }),
  /finite number/i
);

// =========================================================================
// 2. Active-version selection: approved+in-window+max-version wins over
//    higher-version unapproved AND over an expired row.
// =========================================================================
{
  const now = new Date();
  const past = new Date(now.getTime() - 86400000).toISOString();
  const future = new Date(now.getTime() + 86400000).toISOString();
  const rows = [
    // v1: approved, in-window — the correct "old" active candidate if v3 didn't exist
    { Id: 101, BlockId: 500, Content: '<p>v1 approved</p>', Version: 1, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: null, ExpireDateTime: null, Guid: 'g1', CreatedDateTime: past, ModifiedDateTime: past },
    // v5: HIGHEST version but unapproved — must NOT be selected
    { Id: 102, BlockId: 500, Content: '<p>v5 unapproved draft</p>', Version: 5, IsApproved: false,
      ApprovedDateTime: null, ApprovedByPersonAliasId: null, EntityValue: null,
      StartDateTime: null, ExpireDateTime: null, Guid: 'g2', CreatedDateTime: past, ModifiedDateTime: past },
    // v4: approved but EXPIRED — must NOT be selected
    { Id: 103, BlockId: 500, Content: '<p>v4 expired</p>', Version: 4, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: null, ExpireDateTime: past, Guid: 'g3', CreatedDateTime: past, ModifiedDateTime: past },
    // v3: approved, in-window (StartDateTime past, ExpireDateTime future) — the WINNER
    // (highest version among rows satisfying approved+in-window)
    { Id: 104, BlockId: 500, Content: '<p>v3 active winner</p>', Version: 3, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: past, ExpireDateTime: future, Guid: 'g4', CreatedDateTime: past, ModifiedDateTime: past },
    // v2: approved, NOT YET STARTED (future StartDateTime) — must NOT be selected
    { Id: 105, BlockId: 500, Content: '<p>v2 not yet started</p>', Version: 2, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: future, ExpireDateTime: null, Guid: 'g5', CreatedDateTime: past, ModifiedDateTime: past },
  ];
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 500': rows,
    'v1Get:Blocks/500': { Id: 500, Name: 'Test Block', BlockTypeId: 9, PageId: 42, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 500 });
  check('active-version selection picks v3 (approved, in-window, max version among eligible)', result.selected.version === 3);
  check('active-version selection returns the v3 content untouched', result.selected.content === '<p>v3 active winner</p>');
  check('active-version selection does not select higher-version unapproved row', result.html_content_id !== 102);
  check('active-version selection does not select expired row', result.html_content_id !== 103);
  check('active-version selection does not select not-yet-started row', result.html_content_id !== 105);
  check('no warning when a clean active version is found', result.warning === undefined);
  check('block info included for orientation', result.block && result.block.name === 'Test Block' && result.block.zone === 'Main');
  check('versions array includes all 5 rows', result.versions.length === 5);
}

// =========================================================================
// 3. Context rows (EntityValue set) never selected as default; listed in versions
// =========================================================================
{
  const now = new Date();
  const past = new Date(now.getTime() - 86400000).toISOString();
  const rows = [
    // Default-context row, approved, in-window, version 2 — should win
    { Id: 201, BlockId: 600, Content: '<p>default v2</p>', Version: 2, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: null, ExpireDateTime: null, Guid: 'c1', CreatedDateTime: past, ModifiedDateTime: past },
    // Context-specific row with a HIGHER version and approved — must still lose to the default row
    { Id: 202, BlockId: 600, Content: '<p>context-only content for person 77</p>', Version: 9, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: '77',
      StartDateTime: null, ExpireDateTime: null, Guid: 'c2', CreatedDateTime: past, ModifiedDateTime: past },
  ];
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 600': rows,
    'v1Get:Blocks/600': { Id: 600, Name: 'Context Block', BlockTypeId: 9, PageId: 43, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 600 });
  check('context row (EntityValue set) never selected even with higher version', result.selected.version === 2 && result.html_content_id === 201);
  check('default row content returned untouched', result.selected.content === '<p>default v2</p>');
  const contextVersionEntry = result.versions.find((v) => v.id === 202);
  check('context row IS listed in versions metadata', !!contextVersionEntry);
  check('context row entityValue preserved in versions metadata', contextVersionEntry && contextVersionEntry.entityValue === '77');
  check('context row content OMITTED from versions by default (not selected, not all_versions)', contextVersionEntry && contextVersionEntry.content === undefined);
}

// =========================================================================
// 4. No-active fallback: nothing approved/in-window → highest version + warning
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const expired = new Date(Date.now() - 3600000).toISOString();
  const rows = [
    { Id: 301, BlockId: 700, Content: '<p>v1 unapproved</p>', Version: 1, IsApproved: false,
      ApprovedDateTime: null, ApprovedByPersonAliasId: null, EntityValue: null,
      StartDateTime: null, ExpireDateTime: null, Guid: 'n1', CreatedDateTime: past, ModifiedDateTime: past },
    { Id: 302, BlockId: 700, Content: '<p>v2 expired</p>', Version: 2, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: null, ExpireDateTime: expired, Guid: 'n2', CreatedDateTime: past, ModifiedDateTime: past },
  ];
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 700': rows,
    'v1Get:Blocks/700': { Id: 700, Name: 'Stale Block', BlockTypeId: 9, PageId: 44, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 700 });
  check('no-active fallback picks highest version (v2, not v1)', result.selected.version === 2);
  check('no-active fallback sets a warning', typeof result.warning === 'string' && result.warning.length > 0);
  check('no-active fallback warning mentions active-version rule not satisfied', /active-version rule|not currently satisfies|no.*row.*satisf/i.test(result.warning));
}

// =========================================================================
// 4b. Only context-specific rows exist at all → highest version among those + warning
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const rows = [
    { Id: 401, BlockId: 800, Content: '<p>context v1</p>', Version: 1, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: '10',
      StartDateTime: null, ExpireDateTime: null, Guid: 'o1', CreatedDateTime: past, ModifiedDateTime: past },
    { Id: 402, BlockId: 800, Content: '<p>context v2</p>', Version: 2, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: '20',
      StartDateTime: null, ExpireDateTime: null, Guid: 'o2', CreatedDateTime: past, ModifiedDateTime: past },
  ];
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 800': rows,
    'v1Get:Blocks/800': { Id: 800, Name: 'All-Context Block', BlockTypeId: 9, PageId: 45, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 800 });
  check('only-context-rows fallback picks highest version among context rows', result.selected.version === 2 && result.html_content_id === 402);
  check('only-context-rows fallback sets a warning', typeof result.warning === 'string');
  check('only-context-rows warning mentions context-specific / no default row', /context-specific|no default/i.test(result.warning));
}

// =========================================================================
// 5. sha256 correctness against a precomputed known vector
// =========================================================================
{
  // Well-known SHA-256 test vector: sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  const KNOWN_SHA256_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const past = new Date(Date.now() - 86400000).toISOString();
  const row = { Id: 501, BlockId: 900, Content: 'hello', Version: 1, IsApproved: true,
    ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'sh1', CreatedDateTime: past, ModifiedDateTime: past };
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 900': [row],
    'v1Get:Blocks/900': { Id: 900, Name: 'Sha Block', BlockTypeId: 9, PageId: 46, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 900 });
  check('sha256 matches known test vector for "hello"', result.selected.sha256 === KNOWN_SHA256_HELLO);
}

// =========================================================================
// 6. Trailing-whitespace count: "x\n  \n" → 4
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const content = 'x\n  \n';
  const row = { Id: 601, BlockId: 901, Content: content, Version: 1, IsApproved: true,
    ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'tw1', CreatedDateTime: past, ModifiedDateTime: past };
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 901': [row],
    'v1Get:Blocks/901': { Id: 901, Name: 'TW Block', BlockTypeId: 9, PageId: 47, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 901 });
  check('trailing_whitespace_chars("x\\n  \\n") === 4', result.selected.trailing_whitespace_chars === 4);
  check('length_chars preserved exactly (5 for "x\\n  \\n")', result.selected.length_chars === 5);
}

// =========================================================================
// 7. length_bytes vs length_chars diverge on multibyte content (em-dash)
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const content = 'a—b'; // em-dash is 3 bytes in UTF-8, 1 char in JS
  const row = { Id: 701, BlockId: 902, Content: content, Version: 1, IsApproved: true,
    ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'mb1', CreatedDateTime: past, ModifiedDateTime: past };
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 902': [row],
    'v1Get:Blocks/902': { Id: 902, Name: 'MB Block', BlockTypeId: 9, PageId: 48, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { block_id: 902 });
  check('multibyte: length_chars === 3 for "a—b"', result.selected.length_chars === 3);
  check('multibyte: length_bytes === 5 for "a—b" (em-dash is 3 UTF-8 bytes)', result.selected.length_bytes === 5);
  check('multibyte: length_bytes !== length_chars (divergence proven)', result.selected.length_bytes !== result.selected.length_chars);
}

// =========================================================================
// 8. all_versions includes every content; default omits non-selected
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const rows = [
    { Id: 801, BlockId: 903, Content: '<p>version A</p>', Version: 1, IsApproved: false,
      ApprovedDateTime: null, ApprovedByPersonAliasId: null, EntityValue: null,
      StartDateTime: null, ExpireDateTime: null, Guid: 'av1', CreatedDateTime: past, ModifiedDateTime: past },
    { Id: 802, BlockId: 903, Content: '<p>version B active</p>', Version: 2, IsApproved: true,
      ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
      StartDateTime: null, ExpireDateTime: null, Guid: 'av2', CreatedDateTime: past, ModifiedDateTime: past },
  ];
  const client1 = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 903': rows,
    'v1Get:Blocks/903': { Id: 903, Name: 'AV Block', BlockTypeId: 9, PageId: 49, Zone: 'Main' },
  });
  const defaultResult = await getBlockContent(client1, { block_id: 903 });
  const nonSelectedEntry = defaultResult.versions.find((v) => v.id === 801);
  check('default (all_versions false/omitted): non-selected row content omitted', nonSelectedEntry && nonSelectedEntry.content === undefined);
  const selectedEntry = defaultResult.versions.find((v) => v.id === 802);
  check('default: selected row content IS present in its versions entry', selectedEntry && selectedEntry.content === '<p>version B active</p>');
  check('default: top-level selected.content also present', defaultResult.selected.content === '<p>version B active</p>');

  const client2 = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 903': rows,
    'v1Get:Blocks/903': { Id: 903, Name: 'AV Block', BlockTypeId: 9, PageId: 49, Zone: 'Main' },
  });
  const allResult = await getBlockContent(client2, { block_id: 903, all_versions: true });
  const allNonSelectedEntry = allResult.versions.find((v) => v.id === 801);
  check('all_versions:true: non-selected row content IS included', allNonSelectedEntry && allNonSelectedEntry.content === '<p>version A</p>');
  const allSelectedEntry = allResult.versions.find((v) => v.id === 802);
  check('all_versions:true: selected row content still included', allSelectedEntry && allSelectedEntry.content === '<p>version B active</p>');
}

// =========================================================================
// 9. html_content_id direct mode
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const directRow = { Id: 1001, BlockId: 950, Content: '<p>direct fetch</p>', Version: 3, IsApproved: false,
    ApprovedDateTime: null, ApprovedByPersonAliasId: null, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'dm1', CreatedDateTime: past, ModifiedDateTime: past };
  const siblingRow = { Id: 1002, BlockId: 950, Content: '<p>sibling active</p>', Version: 2, IsApproved: true,
    ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'dm2', CreatedDateTime: past, ModifiedDateTime: past };
  const client = makeMockClient({
    'v1Get:HtmlContents/1001': directRow,
    'v1Get:HtmlContents?$filter=BlockId eq 950': [directRow, siblingRow],
    'v1Get:Blocks/950': { Id: 950, Name: 'Direct Block', BlockTypeId: 9, PageId: 50, Zone: 'Main' },
  });
  const result = await getBlockContent(client, { html_content_id: 1001 });
  check('html_content_id direct mode returns exactly that row, bypassing version selection', result.html_content_id === 1001);
  check('html_content_id direct mode returns unapproved row despite an approved sibling existing', result.selected.content === '<p>direct fetch</p>');
  check('html_content_id direct mode derives block_id from the row', result.block_id === 950);
  check('html_content_id direct mode still includes sibling versions metadata', result.versions.some((v) => v.id === 1002));
  check('html_content_id direct mode includes block info', result.block && result.block.name === 'Direct Block');
}

// =========================================================================
// 10. Block 404 with content present → warning, not failure
// =========================================================================
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const row = { Id: 1101, BlockId: 960, Content: '<p>orphaned content</p>', Version: 1, IsApproved: true,
    ApprovedDateTime: past, ApprovedByPersonAliasId: 5, EntityValue: null,
    StartDateTime: null, ExpireDateTime: null, Guid: 'orph1', CreatedDateTime: past, ModifiedDateTime: past };
  const client = makeMockClient({
    'v1Get:HtmlContents?$filter=BlockId eq 960': [row],
    'v1Get:Blocks/960': '__404__',
  });
  const result = await getBlockContent(client, { block_id: 960 });
  check('block 404 does NOT throw — content is still returned', result.selected.content === '<p>orphaned content</p>');
  check('block 404 sets a warning instead of failing', typeof result.warning === 'string' && /Block 960/.test(result.warning));
  check('block 404 leaves block field undefined rather than fabricating one', result.block === undefined);
}

// =========================================================================
// 11. block_id with no rows → clear error naming the block id, not empty success
// =========================================================================
await checkThrows(
  'block_id with zero HtmlContent rows → clear error naming the block id',
  async () => getBlockContent(
    makeMockClient({ 'v1Get:HtmlContents?$filter=BlockId eq 970': [] }),
    { block_id: 970 }
  ),
  /no HtmlContent rows found for block_id 970/i
);
await checkThrows(
  'block_id 404 from Rock itself also produces a clear error (not empty success)',
  async () => getBlockContent(
    makeMockClient({ 'v1Get:HtmlContents?$filter=BlockId eq 971': '__404__' }),
    { block_id: 971 }
  ),
  /404|not found/i
);

// =========================================================================
// 12. html_content_id 404 → clear error naming the id
// =========================================================================
await checkThrows(
  'html_content_id not found → clear error naming the id',
  async () => getBlockContent(
    makeMockClient({ 'v1Get:HtmlContents/9999': '__404__' }),
    { html_content_id: 9999 }
  ),
  /html_content_id 9999/i
);

// =========================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('Failures: ' + failures.join(', '));
process.exit(fail ? 1 : 0);
