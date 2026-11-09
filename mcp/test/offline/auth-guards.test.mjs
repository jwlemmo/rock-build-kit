// Offline tests for src/safety/authGuards.ts — no network; a stub stands in for RockClient.
// Run: npm run build && node --test test/offline/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAuthWrite, writesAuthTable } from '../../dist/safety/authGuards.js';

const ADMIN = 2;
const KEY_PERSON = 100;
const KEY_ALIASES = [900, 901];
const STAFF_GROUP_WITH_KEY_PERSON = 55;

/** authRows: rows the preview SELECT returns for UPDATE/DELETE. */
function stubClient({ authRows = [], failAdmin = false, entityTypes = { 7: 'Rock.Model.Page', 91: 'Rock.Model.RestController' } } = {}) {
  const calls = { sql: [] };
  return {
    calls,
    async executeSql(q) {
      calls.sql.push(q);
      if (/FROM \[Group\] WHERE IsSecurityRole/i.test(q)) { if (failAdmin) throw new Error('timeout'); return [{ Id: ADMIN }]; }
      if (/FROM PersonAlias WHERE PersonId/i.test(q)) return KEY_ALIASES.map((Id) => ({ Id }));
      if (/FROM GroupMember WHERE GroupId = (\d+)/i.test(q)) return [{ N: Number(q.match(/GroupId = (\d+)/)[1]) === STAFF_GROUP_WITH_KEY_PERSON ? 1 : 0 }];
      if (/FROM EntityType WHERE Id = (\d+)/i.test(q)) return [{ Name: entityTypes[Number(q.match(/Id = (\d+)/)[1])] }];
      if (/^SELECT TOP 500 /i.test(q)) return authRows;
      throw new Error('unexpected SQL in stub: ' + q);
    },
    async v1Get(path) {
      if (path === 'People/GetCurrentPerson') return { Id: KEY_PERSON, PrimaryAliasId: 900 };
      throw new Error('unexpected GET ' + path);
    },
  };
}

const run = (sql, opts) => checkAuthWrite(sql, { client: stubClient(opts) });
const insert = (cols, vals, tail = '') => `INSERT INTO Auth (${cols}) SELECT ${vals} ${tail}`.trim();
const COLS = 'EntityTypeId, EntityId, [Order], Action, AllowOrDeny, SpecialRole, GroupId, PersonAliasId, Guid';
const GUARD = "WHERE NOT EXISTS (SELECT 1 FROM Auth a WHERE a.EntityTypeId = 7 AND a.EntityId = 123 AND a.Action = 'View')";

test('non-Auth writes are ignored; Auth detection handles aliases and lookalike tables', async () => {
  const r = await run("UPDATE GroupMember SET GroupMemberStatus = 2 WHERE Id = 1");
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
  assert.equal(writesAuthTable('INSERT INTO AuthClaim (Name) VALUES (1)'), false);
  assert.equal(writesAuthTable('UPDATE a SET a.[Order] = -1 FROM Auth a WHERE a.Id = 3'), true);
  assert.equal(writesAuthTable('DELETE a FROM [dbo].[Auth] AS a WHERE a.Id = 3'), true);
  assert.equal(writesAuthTable('DELETE FROM Auth WHERE Id = 3'), true);
});

test('deleting an Allow row of the admin role is refused', async () => {
  const r = await run('DELETE FROM Auth WHERE Id = 10', { authRows: [{ Id: 10, GroupId: ADMIN, Action: 'View', AllowOrDeny: 'A' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /RSR - Rock Administration/.test(e) && /10/.test(e)));
});

test('changing an Administrate row of the admin role is refused; Modified*-only update is allowed', async () => {
  const rows = [{ Id: 11, GroupId: ADMIN, Action: 'Administrate', AllowOrDeny: 'A' }];
  const r = await run("UPDATE Auth SET AllowOrDeny = 'D' WHERE Id = 11", { authRows: rows });
  assert.equal(r.ok, false);
  const touch = await run('UPDATE Auth SET ModifiedByPersonAliasId = 900 WHERE Id = 11', { authRows: rows });
  assert.equal(touch.ok, true, touch.errors.join('\n'));
});

test('deleting rows of another role passes', async () => {
  const r = await run('DELETE FROM Auth WHERE Id = 12', { authRows: [{ Id: 12, GroupId: 77, Action: 'View', AllowOrDeny: 'A' }] });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('Deny Administrate covering the admin role, All Users, a group the key person is in, or the key person is refused', async () => {
  const cases = [
    `7, 123, -5, 'Administrate', 'D', 0, ${ADMIN}, NULL, NEWID()`,
    `7, 123, -5, 'Administrate', 'D', 1, NULL, NULL, NEWID()`,
    `7, 123, -5, 'Administrate', 'D', 2, NULL, NULL, NEWID()`,
    `7, 123, -5, 'Administrate', 'D', 0, ${STAFF_GROUP_WITH_KEY_PERSON}, NULL, NEWID()`,
    `7, 123, -5, 'Administrate', 'D', 0, NULL, 901, NEWID()`,
    `7, 123, -5, 'Administrate', 'D', 0, g.Id, NULL, NEWID()`, // unreadable group -> fail safe
  ];
  for (const vals of cases) {
    const r = await run(insert(COLS, vals, GUARD));
    assert.equal(r.ok, false, vals);
    assert.ok(r.errors.some((e) => /^Refused: this adds/.test(e)), vals);
  }
  // Deny Administrate for an unrelated group is fine.
  const ok = await run(insert(COLS, `7, 123, -5, 'Administrate', 'D', 0, 77, NULL, NEWID()`, GUARD));
  assert.equal(ok.ok, true, ok.errors.join('\n'));
});

test('UPDATE that turns a row into a Deny Administrate for All Users is refused', async () => {
  const r = await run("UPDATE Auth SET AllowOrDeny = 'D', SpecialRole = 1 WHERE Id = 20", {
    authRows: [{ Id: 20, GroupId: 77, Action: 'Administrate', AllowOrDeny: 'A', SpecialRole: 0, PersonAliasId: null }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /after this UPDATE, Auth row 20/.test(e)));
});

test('person-level rule with Order >= 0 warns; negative Order does not', async () => {
  const bad = await run(insert(COLS, `7, 123, 0, 'View', 'A', 0, NULL, 4242, NEWID()`, GUARD));
  assert.equal(bad.ok, true);
  assert.ok(bad.warnings.some((w) => /Person-level Auth rule has Order 0/.test(w)));
  const good = await run(insert(COLS, `7, 123, -10, 'View', 'A', 0, NULL, 4242, NEWID()`, GUARD));
  assert.equal(good.warnings.some((w) => /Person-level/.test(w)), false);
});

test('EntityId = 0 warns unless the entity type is RestController', async () => {
  const page = await run(insert(COLS, `7, 0, 0, 'View', 'A', 0, 77, NULL, NEWID()`));
  assert.ok(page.warnings.some((w) => /entity-type default row/.test(w)));
  const ctrlById = await run(insert(COLS, `91, 0, 0, 'Execute', 'A', 0, 77, NULL, NEWID()`));
  assert.equal(ctrlById.warnings.some((w) => /entity-type default row/.test(w)), false);
  const ctrlByName = await run(
    "INSERT INTO Auth (EntityTypeId, EntityId, [Order], Action, AllowOrDeny, SpecialRole, GroupId, Guid) SELECT et.Id, 0, 0, 'Execute', 'A', 0, 77, NEWID() FROM EntityType et WHERE et.Name = 'Rock.Model.RestController'"
  );
  assert.equal(ctrlByName.warnings.some((w) => /entity-type default row/.test(w)), false);
});

test('record-level INSERT: no guard warns, guard narrowed by GroupId warns, any-row guard passes', async () => {
  const none = await run(insert(COLS, `7, 123, 0, 'View', 'A', 0, 77, NULL, NEWID()`));
  assert.ok(none.warnings.some((w) => /no NOT EXISTS guard/.test(w)));
  const narrowed = await run(insert(COLS, `7, 123, 0, 'View', 'A', 0, 77, NULL, NEWID()`, "WHERE NOT EXISTS (SELECT 1 FROM Auth a WHERE a.EntityTypeId = 7 AND a.EntityId = 123 AND a.Action = 'View' AND a.GroupId = 77)"));
  assert.ok(narrowed.warnings.some((w) => /only checks rows for this group/.test(w)));
  const guarded = await run(insert(COLS, `7, 123, 0, 'View', 'A', 0, 77, NULL, NEWID()`, GUARD));
  assert.equal(guarded.warnings.some((w) => /guard/i.test(w)), false);
});

test('fails safe: unreadable DELETE target, failed admin lookup, unreadable Administrate INSERT', async () => {
  const topDelete = await run('DELETE TOP (5) FROM Auth WHERE GroupId = 2');
  assert.equal(topDelete.ok, false);
  const noAdmin = await run('DELETE FROM Auth WHERE Id = 10', { failAdmin: true });
  assert.equal(noAdmin.ok, false);
  assert.ok(noAdmin.errors.some((e) => /admin role/.test(e)));
  const unreadable = await run("INSERT INTO Auth SELECT * FROM OtherAuth WHERE Action = 'Administrate'");
  assert.equal(unreadable.ok, false);
  const wholeTable = await run('DELETE FROM Auth', { authRows: Array.from({ length: 500 }, (_, i) => ({ Id: i, GroupId: 77, Action: 'View', AllowOrDeny: 'A' })) });
  assert.equal(wholeTable.ok, false);
});

test('UPDATE [dbo].[Auth] and UPDATE TOP (n) Auth are previewed and refused like UPDATE [Auth]', async () => {
  const rows = [{ Id: 12, GroupId: ADMIN, Action: 'View', AllowOrDeny: 'A' }];
  for (const sql of [
    "UPDATE [dbo].[Auth] SET AllowOrDeny = 'D' WHERE GroupId = 2",
    "UPDATE TOP (50) Auth SET AllowOrDeny = 'D' WHERE GroupId = 2",
    "UPDATE TOP(50) [dbo].[Auth] SET AllowOrDeny = 'D' WHERE GroupId = 2",
    "UPDATE dbo.Auth SET AllowOrDeny = 'D' WHERE GroupId = 2",
  ]) {
    const client = stubClient({ authRows: rows });
    const r = await checkAuthWrite(sql, { client });
    assert.equal(r.ok, false, sql);
    assert.ok(client.calls.sql.some((q) => /^SELECT TOP 500 /i.test(q)), `no preview for: ${sql}`);
    assert.ok(r.errors.some((e) => /RSR - Rock Administration/.test(e) && /12/.test(e)), sql);
  }
});

test('UPDATE whose rows cannot be previewed is refused when it sets a rule column; audit-only stays a warning', async () => {
  // WITH (ROWLOCK) is not a target form the guard reads, so no preview is possible.
  for (const col of ["AllowOrDeny = 'D'", "Action = 'View'", 'GroupId = 5', 'SpecialRole = 1', 'PersonAliasId = 7', 'EntityTypeId = 7', 'EntityId = 9']) {
    const r = await run(`UPDATE Auth WITH (ROWLOCK) SET ${col} WHERE GroupId = 2`);
    assert.equal(r.ok, false, col);
    assert.ok(r.errors.some((e) => /could not work out which Auth rows/.test(e)), col);
  }
  const audit = await run('UPDATE Auth WITH (ROWLOCK) SET ModifiedByPersonAliasId = 900 WHERE GroupId = 2');
  assert.equal(audit.ok, true, audit.errors.join('\n'));
  assert.ok(audit.warnings.some((w) => /lockout checks were not run/.test(w)));
});
