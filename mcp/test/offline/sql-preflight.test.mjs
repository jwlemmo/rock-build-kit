// Offline tests for src/safety/sqlPreflight.ts — no network; a stub stands in for RockClient.
// Run: npm run build && node --test test/offline/*.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { preflightSqlWrite, clearPreflightCache, rockNowSql } from '../../dist/safety/sqlPreflight.js';

// The kit never assumes a time zone; these tests configure one (any Windows id works).
process.env.ROCK_TIMEZONE = 'Mountain Standard Time';
const NOW = rockNowSql();

const col = (name, nullable = true, hasDefault = false, identity = false) => ({
  COLUMN_NAME: name, IS_NULLABLE: nullable ? 'YES' : 'NO', HasDefault: hasDefault ? 1 : 0, IsIdentity: identity ? 1 : 0, IsComputed: 0,
});

// Column sets copied from a Rock 19 INFORMATION_SCHEMA (2026-11-08), trimmed to what matters.
const TABLES = {
  GroupMember: [
    col('Id', false, false, true), col('IsSystem', false), col('GroupId', false), col('PersonId', false), col('GroupRoleId', false),
    col('GroupMemberStatus', false), col('Guid', false), col('CreatedDateTime'), col('ModifiedDateTime'), col('CreatedByPersonAliasId'),
    col('ModifiedByPersonAliasId'), col('DateTimeAdded'), col('IsNotified', false, true), col('IsArchived', false, true),
    col('CommunicationPreference', false, true), col('GroupTypeId', false),
  ],
  Auth: [
    col('Id', false, false, true), col('EntityTypeId', false), col('EntityId'), col('Order', false), col('Action', false),
    col('AllowOrDeny', false), col('SpecialRole', false), col('GroupId'), col('Guid', false), col('CreatedDateTime'),
    col('ModifiedDateTime'), col('CreatedByPersonAliasId'), col('ModifiedByPersonAliasId'), col('PersonAliasId'),
  ],
  MetricValue: [col('Id', false, false, true), col('MetricId', false), col('YValue'), col('Guid', false), col('CreatedDateTime'), col('ModifiedDateTime')],
};

function stubClient({ currentPerson = { Id: 100, PrimaryAliasId: 900 }, failPerson = false } = {}) {
  const calls = { sql: [], get: [] };
  return {
    calls,
    async executeSql(q) {
      calls.sql.push(q);
      const t = q.match(/TABLE_NAME = '(\w+)'/);
      if (t) return TABLES[t[1]] ?? [];
      if (/FROM PersonAlias/i.test(q)) return [{ Id: 901 }];
      throw new Error('unexpected SQL in stub: ' + q);
    },
    async v1Get(path) {
      calls.get.push(path);
      if (failPerson) throw new Error('401');
      if (path === 'People/GetCurrentPerson') return currentPerson;
      throw new Error('unexpected GET ' + path);
    },
  };
}

const ctx = (client, target = 'dev') => ({ client, target });

beforeEach(() => clearPreflightCache());

test('complete GroupMember INSERT passes, audit columns are added and reported', async () => {
  const sql =
    "INSERT INTO GroupMember (IsSystem, GroupId, PersonId, GroupRoleId, GroupMemberStatus, GroupTypeId, DateTimeAdded, Guid) " +
    `SELECT 0, 2, 5, 1, 1, 1, ${NOW}, 'a11ce5c0-1111-4f00-9e00-000000000001' WHERE NOT EXISTS (SELECT 1 FROM GroupMember WHERE GroupId = 2 AND PersonId = 5)`;
  const r = await preflightSqlWrite(sql, ctx(stubClient()));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.match(r.sql, /^INSERT INTO GroupMember \(\[CreatedDateTime\], \[ModifiedDateTime\], \[CreatedByPersonAliasId\], \[ModifiedByPersonAliasId\], IsSystem/);
  assert.ok(r.sql.includes(`SELECT ${NOW}, ${NOW}, 900, 900, 0, 2, 5`));
  assert.equal(r.warnings.filter((w) => w.startsWith('Added ')).length, 4);
});

test('VALUES with several rows gets the additions in every row', async () => {
  const sql = "INSERT INTO MetricValue (MetricId, YValue, Guid) VALUES (1, 2, 'a11ce5c0-1111-4f00-9e00-000000000002'), (1, 3, 'a11ce5c0-1111-4f00-9e00-000000000003')";
  const r = await preflightSqlWrite(sql, ctx(stubClient()));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.sql.split(NOW).length - 1, 4);
  assert.match(r.sql, /VALUES \(CAST.*, 1, 2, 'a11ce5c0[^)]*\), \(CAST.*, 1, 3, /);
});

test('missing NOT NULL column without default is an error', async () => {
  const r = await preflightSqlWrite("INSERT INTO MetricValue (YValue, Guid) VALUES (2, 'a11ce5c0-1111-4f00-9e00-000000000004')", ctx(stubClient()));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /MetricValue\.MetricId is NOT NULL/.test(e)));
});

test('IsSystem on a table without it is an error', async () => {
  const r = await preflightSqlWrite("INSERT INTO MetricValue (IsSystem, MetricId, Guid) VALUES (0, 1, 'a11ce5c0-1111-4f00-9e00-000000000005')", ctx(stubClient()));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no IsSystem column/.test(e)));
});

test('GETDATE() and SYSDATETIME() are errors and suggest the configured-time-zone expression', async () => {
  for (const fn of ['GETDATE()', 'SYSDATETIME()', 'getdate ( )']) {
    const r = await preflightSqlWrite(`UPDATE GroupMember SET ModifiedDateTime = ${fn}, ModifiedByPersonAliasId = 1 WHERE Id = 1`, ctx(stubClient()));
    assert.equal(r.ok, false, fn);
    assert.ok(r.errors.some((e) => e.includes("database server's clock") && e.includes(NOW)), fn);
  }
  // SYSDATETIMEOFFSET (the base of the time-zone expression) and literals mentioning GETDATE are fine.
  const ok = await preflightSqlWrite(`UPDATE GroupMember SET ModifiedDateTime = ${NOW}, ModifiedByPersonAliasId = 1, Note = 'GETDATE()' WHERE Id = 1`, ctx(stubClient()));
  assert.equal(ok.ok, true, ok.errors.join('\n'));
});

test('GroupMember INSERT without GroupTypeId is an error; missing DateTimeAdded is a warning', async () => {
  const sql = "INSERT INTO GroupMember (IsSystem, GroupId, PersonId, GroupRoleId, GroupMemberStatus, Guid) VALUES (0, 2, 5, 1, 1, 'a11ce5c0-1111-4f00-9e00-000000000006')";
  const r = await preflightSqlWrite(sql, ctx(stubClient()));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must set GroupTypeId/.test(e)));
  assert.ok(r.warnings.some((w) => /DateTimeAdded/.test(w)));
  assert.equal(r.sql.includes('[CreatedDateTime]'), false, 'no rewrite when the INSERT has errors');
});

test('UPDATE is never rewritten; missing Modified* columns are warnings', async () => {
  const sql = 'UPDATE GroupMember SET GroupMemberStatus = 2 WHERE Id = 7';
  const r = await preflightSqlWrite(sql, ctx(stubClient()));
  assert.equal(r.ok, true);
  assert.equal(r.sql, sql);
  assert.ok(r.warnings.some((w) => /ModifiedDateTime/.test(w)));
  assert.ok(r.warnings.some((w) => /ModifiedByPersonAliasId/.test(w)));
});

test('QUOTED_IDENTIFIER is reported, not prepended (single-statement write path)', async () => {
  const r = await preflightSqlWrite('DELETE FROM MetricValue WHERE Id = 3', ctx(stubClient()));
  assert.equal(r.ok, true);
  assert.equal(/QUOTED_IDENTIFIER/i.test(r.sql), false);
  assert.ok(r.warnings.some((w) => /QUOTED_IDENTIFIER/.test(w)));
});

test('INSERT without a column list, unknown table, and the existing validator are all enforced', async () => {
  const noCols = await preflightSqlWrite("INSERT INTO MetricValue VALUES (1, 2, 'x')", ctx(stubClient()));
  assert.ok(noCols.errors.some((e) => /name its columns/.test(e)));
  const unknown = await preflightSqlWrite('INSERT INTO NoSuchTable (A) VALUES (1)', ctx(stubClient()));
  assert.ok(unknown.errors.some((e) => /not found/.test(e)));
  const stacked = await preflightSqlWrite('DELETE FROM MetricValue WHERE Id = 3; DROP TABLE Person', ctx(stubClient()));
  assert.equal(stacked.ok, false);
  assert.ok(stacked.errors.some((e) => /SQL write rejected/.test(e)));
});

test('alias lookup: falls back to PersonAlias SELECT; failure leaves alias columns out with a warning', async () => {
  const c1 = stubClient({ currentPerson: { Id: 100 } });
  const r1 = await preflightSqlWrite("INSERT INTO GroupMember (IsSystem, GroupId, PersonId, GroupRoleId, GroupMemberStatus, GroupTypeId, DateTimeAdded, Guid) VALUES (0,2,5,1,1,1,NULL,'a11ce5c0-1111-4f00-9e00-000000000007')", ctx(c1, 'prod'));
  assert.ok(r1.sql.includes(', 901, 901, 0,'));
  clearPreflightCache();
  const r2 = await preflightSqlWrite("INSERT INTO GroupMember (IsSystem, GroupId, PersonId, GroupRoleId, GroupMemberStatus, GroupTypeId, DateTimeAdded, Guid) VALUES (0,2,5,1,1,1,NULL,'a11ce5c0-1111-4f00-9e00-000000000008')", ctx(stubClient({ failPerson: true })));
  assert.equal(r2.ok, true);
  assert.equal(r2.sql.includes('PersonAliasId]'), false);
  assert.ok(r2.warnings.some((w) => /could not look up the API key's person/.test(w)));
});

test('column lookups are cached per target', async () => {
  const c = stubClient();
  const sql = 'DELETE FROM MetricValue WHERE Id = 3';
  await preflightSqlWrite("INSERT INTO MetricValue (MetricId, YValue, Guid, CreatedDateTime, ModifiedDateTime) VALUES (1,2,'g',NULL,NULL)", ctx(c));
  await preflightSqlWrite("INSERT INTO MetricValue (MetricId, YValue, Guid, CreatedDateTime, ModifiedDateTime) VALUES (1,2,'g',NULL,NULL)", ctx(c));
  assert.equal(c.calls.sql.filter((q) => q.includes('INFORMATION_SCHEMA')).length, 1);
  await preflightSqlWrite("INSERT INTO MetricValue (MetricId, YValue, Guid, CreatedDateTime, ModifiedDateTime) VALUES (1,2,'g',NULL,NULL)", ctx(c, 'prod'));
  assert.equal(c.calls.sql.filter((q) => q.includes('INFORMATION_SCHEMA')).length, 2);
  void sql;
});

test('NOW uses ROCK_TIMEZONE, not a built-in zone', () => {
  assert.equal(NOW, "CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Mountain Standard Time' AS datetime)");
});

test('without ROCK_TIMEZONE: GETDATE is refused with setup help, and no time columns are added', async () => {
  const saved = process.env.ROCK_TIMEZONE;
  delete process.env.ROCK_TIMEZONE;
  try {
    assert.equal(rockNowSql(), undefined);
    const r = await preflightSqlWrite('UPDATE GroupMember SET ModifiedDateTime = GETDATE(), ModifiedByPersonAliasId = 1 WHERE Id = 1', ctx(stubClient()));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('Set ROCK_TIMEZONE') && !e.includes('AT TIME ZONE')), r.errors.join('\n'));
    const ins = await preflightSqlWrite(
      "INSERT INTO MetricValue (MetricId, YValue, Guid) VALUES (1, 5, 'a11ce5c0-1111-4f00-9e00-000000000009')",
      ctx(stubClient())
    );
    assert.equal(ins.ok, true, ins.errors.join('\n'));
    assert.equal(ins.sql.includes('CreatedDateTime'), false);
    assert.ok(ins.warnings.some((w) => /ROCK_TIMEZONE is not set/.test(w)));
    // A malformed id (a quote could break out of the SQL literal) counts as unset.
    process.env.ROCK_TIMEZONE = "Central' ; DROP";
    assert.equal(rockNowSql(), undefined);
  } finally {
    process.env.ROCK_TIMEZONE = saved;
  }
});
