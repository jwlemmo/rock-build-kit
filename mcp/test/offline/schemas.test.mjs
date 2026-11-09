// Every write tool declares a required reason; the server instructions carry the write rules
// and no Rock version or shared-key wording; rock_edit (REST) runs the same handshake with read-back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, load, ledger, stubClient, check, rejects, done } from './_harness.mjs';

const { WRITE_TOOLS, runWriteTool } = await load('safety/index.js');
const mods = await Promise.all(
  ['people', 'groups', 'attributes', 'attendance', 'notes', 'steps', 'workflows', 'reservations', 'rock-write', 'rock-restore', 'block-content', 'page-bundle', 'metrics'].map((m) => load(`tools/${m}.js`))
);
const schemas = new Map();
for (const m of mods) for (const v of Object.values(m)) if (v && typeof v === 'object' && typeof v.name === 'string' && v.inputSchema) schemas.set(v.name, v);

const tools = Object.keys(WRITE_TOOLS);
check('schemas: 22 write tools listed', tools.length === 22, tools.length);
for (const t of tools) {
  const s = schemas.get(t);
  check(`schemas: ${t} has a reason parameter`, !!s?.inputSchema?.properties?.reason, t);
  if (t !== 'rock_restore') check(`schemas: ${t} requires reason`, s?.inputSchema?.required?.includes('reason'), s?.inputSchema?.required);
}
for (const t of ['rock_create', 'rock_edit', 'rock_delete', 'create_page_bundle', 'create_reservation']) {
  check(`schemas: ${t} accepts allowBulk`, !!schemas.get(t)?.inputSchema?.properties?.allowBulk);
}
for (const t of ['update_person', 'update_person_address', 'update_person_phone', 'remove_person_tag', 'set_person_attribute', 'remove_group_member', 'update_group', 'update_reservation']) {
  check(`schemas: ${t} accepts confirmation_token`, !!schemas.get(t)?.inputSchema?.properties?.confirmation_token);
}

const src = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8');
// The public kit discovers the Rock version at runtime; instructions name no version.
check('instructions: name no Rock version', !/\b1[789]\.\d+\.\d+\b/.test(src.slice(src.indexOf('SERVER_INSTRUCTIONS'), src.indexOf('function createMcpServer'))));
check('instructions: describe the reason rule', src.includes('Every write tool requires a reason'));
check('instructions: describe ROCK_TIMEZONE', src.includes('ROCK_TIMEZONE'));
check('instructions: no shared-key wording', !/shared (REST |Rock )?key|key is shared/i.test(src));

// rock_edit REST: preview → execute with read-back; changed body refused + ledgered.
{
  let row = { Id: 9, Guid: 'dddddddd-0000-0000-0000-000000000009', Name: 'Old', IsActive: true };
  const { client, writes } = stubClient({
    'v1Get Blocks/9': () => ({ ...row }),
    'v1Patch Blocks/9': (_p, body) => { row = { ...row, ...body }; },
    'executeSql': () => [],
  });
  const args = { mode: 'rest', controller: 'Blocks', id: 9, body: { Name: 'New' }, reason: 'Rename block' };
  const prev = await runWriteTool('rock_edit', args, () => load('tools/rock-write.js').then((m) => m.rockEdit(client, args)));
  check('rock_edit: preview with token, nothing written', prev.phase === 'preview' && !!prev.confirmation_token && writes().length === 0, prev.phase);
  const { rockEdit } = await load('tools/rock-write.js');
  await rejects('rock_edit: changed body refused', () => runWriteTool('rock_edit', { ...args, body: { Name: 'Other' }, confirmation_token: prev.confirmation_token }, () => rockEdit(client, { ...args, body: { Name: 'Other' }, confirmation_token: prev.confirmation_token })), /token mismatch/i);
  const exec = await runWriteTool('rock_edit', { ...args, confirmation_token: prev.confirmation_token }, () => rockEdit(client, { ...args, confirmation_token: prev.confirmation_token }));
  check('rock_edit: executes and verifies', exec.phase === 'executed' && exec.verified === true && writes().length === 1, exec);
  const recs = ledger().filter((r) => r.tool === 'rock_edit');
  check('rock_edit: preview, denied and executed all ledgered with the reason', ['preview', 'denied', 'executed'].every((p) => recs.some((r) => r.phase === p && r.reason === 'Rename block')), recs.map((r) => r.phase));
}

// Read tools are untouched by the write rules (no reason needed).
{
  const r = await runWriteTool('search_people', {}, async () => 'read-ok');
  check('read tools pass straight through', r === 'read-ok');
  const l = await runWriteTool('rock_restore', {}, async () => 'list-ok');
  check('rock_restore list mode needs no reason', l === 'list-ok');
}

done('schemas.test.mjs');
