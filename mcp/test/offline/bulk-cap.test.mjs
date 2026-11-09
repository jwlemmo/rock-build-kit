// Bulk cap: refusal over the limit (default 25), count shown, allowBulk override, env override,
// and denials ledgered.
import { load, ledger, stubClient, check, rejects, done } from './_harness.mjs';

const { runWriteTool, bulkWriteMax } = await load('safety/index.js');
const { rockCreate } = await load('tools/rock-write.js');
const { createPageBundle } = await load('tools/page-bundle.js');
const { createReservation } = await load('tools/reservations.js');

check('bulk: default limit is 25', bulkWriteMax() === 25, bulkWriteMax());

// rock_create mode:"sql" INSERT ... VALUES with 30 tuples
{
  const tuples = Array.from({ length: 30 }, (_, i) => `(${i + 1}, 'row ''${i + 1}'' (x)')`).join(', ');
  const sql = `INSERT INTO [DefinedValue] (DefinedTypeId, Value) VALUES ${tuples}`;
  const { client, calls } = stubClient({});
  const args = { mode: 'sql', sql, reason: 'Load the room list' };
  const err = await rejects('rock_create: 30-row INSERT refused', () => runWriteTool('rock_create', args, () => rockCreate(client, args)), /would touch 30 rows, over the bulk limit of 25/);
  check('rock_create: refusal names allowBulk', /allowBulk:true/.test(err?.message ?? ''));
  check('rock_create: nothing sent to Rock', calls.length === 0, calls);
  const denied = ledger().filter((r) => r.tool === 'rock_create' && r.phase === 'denied');
  check('rock_create: bulk refusal ledgered with table target', denied.length === 1 && denied[0].target?.table === 'DefinedValue', denied[0]);
  check('rock_create: denied record keeps the reason', denied[0]?.reason === 'Load the room list');
}

// rock_create mode:"sql" INSERT ... SELECT counted with a read-only COUNT(*)
{
  const { client, calls } = stubClient({ 'executeSql': (q) => (/COUNT\(\*\)/.test(q) ? [{ n: 40 }] : []) });
  const args = { mode: 'sql', sql: 'INSERT INTO [Auth] (EntityTypeId, EntityId) SELECT 1, Id FROM [Page] WHERE ParentPageId = 5', reason: 'Lock pages' };
  await rejects('rock_create: INSERT…SELECT counted and refused', () => runWriteTool('rock_create', args, () => rockCreate(client, args)), /would touch 40 rows/);
  check('rock_create: only the COUNT query ran', calls.length === 1 && calls[0].method === 'executeSql' && /COUNT\(\*\)/.test(calls[0].args[0]), calls);
}

// create_page_bundle: 3 core objects + 30 Allow rows + 1 Deny = 34 objects
{
  const roles = Array.from({ length: 30 }, (_, i) => 1000 + i);
  const { client, calls } = stubClient({});
  // layout_id / block_type_id are passed explicitly: the kit discovers them per church otherwise.
  const args = { name: 'Big Page', parent_page_id: 12, layout_id: 3, block_type_id: 4, content: '<p>x</p>', allow_role_ids: roles, reason: 'New admin page' };
  await rejects('create_page_bundle: 34 objects refused', () => runWriteTool('create_page_bundle', args, () => createPageBundle(client, args)), /would touch 34 rows/);
  check('create_page_bundle: nothing sent to Rock', calls.length === 0);

  // allowBulk:true lets it through (stub creates everything).
  let next = 5000;
  const { client: c2, writes } = stubClient({ v1Post: () => next++, v1Patch: () => undefined, v1Get: (p) => (p === 'EntityTypes' ? [{ Id: 2 }] : { Id: Number(p.split('/')[1]) }) });
  const ok = await runWriteTool('create_page_bundle', { ...args, allowBulk: true }, () => createPageBundle(c2, { ...args, allowBulk: true }));
  check('create_page_bundle: allowBulk:true proceeds', ok.success === true && ok.planned_objects === 34, { success: ok.success, planned: ok.planned_objects });
  check('create_page_bundle: all objects verified', ok.all_verified === true, ok.verified);
  check('create_page_bundle: 34 POSTs + 1 flush PATCH', writes().length === 35, writes().length);
  const created = ledger().filter((r) => r.tool === 'create_page_bundle' && r.phase === 'create');
  check('create_page_bundle: each object ledgered with the reason', created.length === 34 && created.every((r) => r.reason === 'New admin page'), created.length);
  check('create_page_bundle: new pages hide title and breadcrumb (team kit standard)', created[0]?.payload?.body?.PageDisplayTitle === false && created[0]?.payload?.body?.PageDisplayBreadCrumb === false, created[0]?.payload?.body);
}

// ROCK_MCP_BULK_WRITE_MAX override: 3 → a reservation with 2 rooms (4 rows) is refused
{
  process.env.ROCK_MCP_BULK_WRITE_MAX = '3';
  check('bulk: env override read', bulkWriteMax() === 3);
  const { client, calls } = stubClient({});
  const args = { name: 'Retreat', reservationTypeId: 7, startDateTime: '2026-12-01T09:00:00', endDateTime: '2026-12-01T12:00:00', locationIds: [11, 12], reason: 'Staff retreat' };
  await rejects('create_reservation: 4 rows over a limit of 3 refused', () => runWriteTool('create_reservation', args, () => createReservation(client, args)), /would touch 4 rows, over the bulk limit of 3/);
  check('create_reservation: nothing sent to Rock', calls.length === 0);
  delete process.env.ROCK_MCP_BULK_WRITE_MAX;
}

done('bulk-cap.test.mjs');
