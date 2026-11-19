// Security-role adds go through the configured role-member Lava endpoint (never v1 REST or SQL);
// write results and refusals carry a next step; execute_sql warns on single-alias giving filters.
import { load, ledger, stubClient, check, rejects, done } from './_harness.mjs';

const { runWriteTool } = await load('safety/index.js');
const { withNextStep, errorWithNextStep } = await load('safety/nextStep.js');
const { UNCERTAIN_OUTCOME_NOTE } = await load('safety/writeGuard.js');
const { addGroupMember } = await load('tools/groups.js');
const { mergedRecordWarning } = await load('tools/sql.js');

const run = (tool, fn, client, args) => runWriteTool(tool, args, () => fn(client, args));
const roleGroup = (ctrl) => (ctrl === 'groups' ? [{ isSecurityRole: true, groupTypeId: 1 }] : []);

// ---------------------------------------------------------------- no endpoint configured
{
  delete process.env.ROCK_ROLE_MEMBER_ENDPOINT;
  const { client, writes } = stubClient({ v2Search: roleGroup });
  await rejects(
    'role add: refused without ROCK_ROLE_MEMBER_ENDPOINT',
    () => run('add_group_member', addGroupMember, client, { groupId: 2, personId: 42, reason: 'Grant admin console' }),
    /ROCK_ROLE_MEMBER_ENDPOINT/
  );
  check('role add: nothing written without the endpoint', writes().length === 0);
}

// ---------------------------------------------------------------- endpoint configured
{
  process.env.ROCK_ROLE_MEMBER_ENDPOINT = 'mcp-tools/role-member';
  const { client, calls, writes } = stubClient({
    v2Search: roleGroup,
    lavaAppPost: () => ({ ok: true, result: 'added', groupMemberId: 501, group: 'Test Role' }),
    executeSql: () => [{ Id: 501, GroupMemberStatus: 1, GroupTypeId: 1 }],
  });
  const res = await run('add_group_member', addGroupMember, client, { groupId: 2, personId: 42, reason: 'Grant admin console' });
  const post = calls.find((c) => c.method === 'lavaAppPost');
  check('role add: calls the configured endpoint', post?.args[0] === 'mcp-tools' && post?.args[1] === 'role-member', post?.args);
  check('role add: sends person, group and reason', post?.args[2]?.personId === 42 && post?.args[2]?.groupId === 2 && post?.args[2]?.reason === 'Grant admin console');
  check('role add: no v1 REST or SQL write', writes().every((w) => w.method === 'lavaAppPost'));
  check('role add: verified by read-back', res.success === true && res.groupMemberId === 501 && res.verified === true, res);
  const rec = ledger().find((r) => r.tool === 'add_group_member');
  check('role add: ledgered with newId for undo', rec?.phase === 'create' && rec?.result?.newId === 501, rec);

  const { client: c2 } = stubClient({
    v2Search: roleGroup,
    lavaAppPost: () => ({ ok: false, result: 'not valid', next: 'Check the ids.' }),
  });
  await rejects(
    'role add: endpoint refusal surfaces Rock\'s answer',
    () => run('add_group_member', addGroupMember, c2, { groupId: 2, personId: 42, reason: 'Grant admin console' }),
    /not valid/
  );

  const { client: cR } = stubClient({
    v2Search: roleGroup,
    lavaAppPost: () => ({ ok: true, result: 'reactivated', groupMemberId: 77, group: 'Test Role' }),
    executeSql: () => [{ Id: 77, GroupMemberStatus: 1, GroupTypeId: 1 }],
  });
  const re = withNextStep('add_group_member', await run('add_group_member', addGroupMember, cR, { groupId: 2, personId: 43, reason: 'Restore access' }));
  check('role add: reactivation says rock_restore cannot undo it', /cannot undo a reactivation/.test(re.next ?? ''), re.next);

  const { client: c3, writes: w3 } = stubClient({
    v2Search: (ctrl) => (ctrl === 'groups' ? [{ isSecurityRole: true }] : [{ id: 9 }]),
  });
  const noop = await run('add_group_member', addGroupMember, c3, { groupId: 2, personId: 42, reason: 'Grant admin console' });
  check('role add: already an active member writes nothing', noop.written === false && w3().length === 0, noop);
  await rejects(
    'role add: inactive status refused for roles',
    () => run('add_group_member', addGroupMember, c3, { groupId: 2, personId: 42, status: 0, reason: 'x y' }),
    /only take active members/
  );
  delete process.env.ROCK_ROLE_MEMBER_ENDPOINT;
}

// ---------------------------------------------------------------- next steps
{
  check('next: preview says STOP', /^STOP/.test(withNextStep('rock_edit', { phase: 'preview' }).next));
  check('next: verified write offers undo', /rock_restore with auditId abc/.test(withNextStep('add_note', { verified: true, auditId: 'abc' }).next));
  check('next: unverified write says check first', /do not retry/i.test(withNextStep('add_note', { verified: false }).next));
  check('next: read tools untouched', withNextStep('search_people', { rows: [] }).next === undefined);
  check('next: refusal tells the agent nothing was written', /Next: nothing was written/.test(errorWithNextStep('add_note', 'reason is required')));
  check('next: uncertain outcome says check Rock', /Next: check in Rock/.test(errorWithNextStep('add_note', 'outcome uncertain')));
  check('next: the real uncertain-outcome note says check Rock', /Next: check in Rock/.test(errorWithNextStep('add_note', `add_note failed: ${UNCERTAIN_OUTCOME_NOTE}`)));
  check('next: endpoint "not saved" says check Rock', /Next: check in Rock/.test(errorWithNextStep('add_group_member', 'add_group_member: Rock answered "not saved". Do not retry blindly.')));
}

// ---------------------------------------------------------------- merged-record warning
{
  check('merged: warns on one alias', !!mergedRecordWarning('SELECT * FROM FinancialTransaction ft WHERE ft.AuthorizedPersonAliasId = 12'));
  check('merged: warns on a literal alias list', !!mergedRecordWarning('SELECT * FROM Attendance a WHERE a.PersonAliasId IN (1,2)'));
  check('merged: quiet when filtering on PersonId', mergedRecordWarning('SELECT * FROM FinancialTransaction ft JOIN PersonAlias pa ON pa.Id = ft.AuthorizedPersonAliasId WHERE pa.PersonId = 5') === null);
  check('merged: quiet for unrelated tables', mergedRecordWarning('SELECT * FROM GroupMember WHERE PersonAliasId = 3') === null);
}

done('role-member-and-next-step.test.mjs');
