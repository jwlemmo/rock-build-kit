// rock_restore re-creates a deleted security-role GroupMember by a validated SQL INSERT (Rock's
// v1 REST refuses role membership with 403). Whether the group is a security role is read from
// Rock (IsSecurityRole or the stock Security Role group type Guid), never assumed from an Id, and
// the GroupTypeId written is the one Rock reports. Dates use ROCK_TIMEZONE when set, NULL when not.
import { load, stubClient, check, done } from './_harness.mjs';

const { appendAudit, writeSnapshotFile } = await load('safety/audit.js');
const { runWriteTool } = await load('safety/index.js');
const { rockRestore } = await load('tools/rock-restore.js');

const GUID = 'abcdef01-2345-4678-9abc-def012345678';

async function seedDeletedMember(auditId, groupTypeId) {
  const snapshotRef = await writeSnapshotFile(`${auditId}-before`, {
    Id: 501, Guid: GUID, GroupId: 77, PersonId: 42, GroupRoleId: 3, GroupMemberStatus: 1,
    GroupTypeId: groupTypeId, IsNotified: false, IsArchived: false, CommunicationPreference: 0, IsSystem: false,
  });
  await appendAudit({
    auditId, ts: '2026-06-03T09:00:00.000Z', phase: 'executed',
    operator: { email: 'tester@example.org', name: 'Offline Tester', source: 'env' },
    tool: 'rock_delete', verb: 'delete', mode: 'rest', target: { entityType: 'GroupMember', id: 501 },
    snapshotRef, payload: { action: 'deleted', hard: true }, reason: 'Remove a role member', result: { success: true },
  });
}

function roleClient({ isRole, groupTypeId }) {
  let inserted = false;
  return stubClient({
    v1Get: (p) => { throw new Error(`Rock v1 GET ${p} → 404: Not Found`); },
    v1Post: () => { throw new Error('Rock v1 POST GroupMembers → 403: Security role membership cannot be managed through this endpoint'); },
    executeSqlCommand: () => { inserted = true; return 1; },
    executeSql: (q) => {
      if (/FROM \[Group\] g JOIN GroupType gt/.test(q)) return [{ GroupTypeId: groupTypeId, IsRole: isRole ? 1 : 0 }];
      if (/SELECT Id FROM GroupMember WHERE Guid/.test(q)) return inserted ? [{ Id: 9001 }] : [];
      return [];
    },
  });
}

async function restore(client, auditId) {
  const args = { audit_id: auditId, reason: 'Put the role member back' };
  const prev = await runWriteTool('rock_restore', args, () => rockRestore(client, args));
  const execArgs = { ...args, confirmation_token: prev.confirmation_token };
  return { prev, exec: await runWriteTool('rock_restore', execArgs, () => rockRestore(client, execArgs)) };
}

// A role whose group type has a church-specific Id (not 1): detected from Rock, Id carried through.
process.env.ROCK_TIMEZONE = 'Pacific Standard Time';
await seedDeletedMember('rolemem1aaaaaaaa', 31);
{
  const { client, calls } = roleClient({ isRole: true, groupTypeId: 31 });
  const { prev, exec } = await restore(client, 'rolemem1aaaaaaaa');
  check('role restore: preview first', prev.phase === 'preview' && typeof prev.confirmation_token === 'string', prev);
  const insert = calls.find((c) => c.method === 'executeSqlCommand');
  check('role restore: re-created by SQL INSERT, no REST POST', !!insert && !calls.some((c) => c.method === 'v1Post'), calls.map((c) => c.method));
  const sql = insert?.args[0] ?? '';
  check('role restore: GroupTypeId comes from Rock (31)', /VALUES \(0, 77, 42, 3, 1, 31,/.test(sql), sql);
  check('role restore: keeps the Guid', sql.includes(`'${GUID}'`), sql);
  check('role restore: dates use ROCK_TIMEZONE', sql.includes("AT TIME ZONE 'Pacific Standard Time'") && !/Central/.test(sql), sql);
  check('role restore: executed with the new Id', exec.phase === 'executed' && exec.newId === 9001, exec);
}

// Without ROCK_TIMEZONE the dates are left NULL instead of guessing a zone.
delete process.env.ROCK_TIMEZONE;
await seedDeletedMember('rolemem2bbbbbbbb', 1);
{
  const { client, calls } = roleClient({ isRole: true, groupTypeId: 1 });
  await restore(client, 'rolemem2bbbbbbbb');
  const sql = calls.find((c) => c.method === 'executeSqlCommand')?.args[0] ?? '';
  check('role restore: no ROCK_TIMEZONE means NULL dates', !/TIME ZONE/.test(sql) && /, NULL, '/.test(sql), sql);
}

// An ordinary group goes through REST as before.
await seedDeletedMember('plainmem3ccccccc', 1);
{
  let posted = 0;
  const { client, calls } = stubClient({
    v1Get: (p) => {
      if (p === 'GroupMembers/700') return { Id: 700 };
      throw new Error(`Rock v1 GET ${p} → 404: Not Found`);
    },
    v1Post: () => { posted++; return 700; },
    executeSql: (q) => (/FROM \[Group\] g JOIN GroupType gt/.test(q) ? [{ GroupTypeId: 1, IsRole: 0 }] : []),
  });
  const { exec } = await restore(client, 'plainmem3ccccccc');
  check('plain group restore: uses REST POST, not SQL', posted === 1 && !calls.some((c) => c.method === 'executeSqlCommand'), calls.map((c) => c.method));
  check('plain group restore: executed', exec.phase === 'executed' && exec.newId === 700, exec);
}

done('security-role-restore.test.mjs');
