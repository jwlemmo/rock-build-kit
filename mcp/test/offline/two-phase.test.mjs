// update_person and remove_group_member: preview -> token -> execute, token mismatch,
// changed reason, missing reason, denial records, ledger written to the temp folder.
import { load, ledger, stubClient, notFound, check, rejects, done } from './_harness.mjs';

const { runWriteTool } = await load('safety/index.js');
const { updatePerson } = await load('tools/people.js');
const { removeGroupMember } = await load('tools/groups.js');

const run = (tool, fn, client, args) => runWriteTool(tool, args, () => fn(client, args));

// ---------------------------------------------------------------- update_person
{
  let person = { Id: 42, Guid: 'aaaaaaaa-0000-0000-0000-000000000042', FirstName: 'Old', LastName: 'Name', Email: 'x@y.z' };
  const { client, writes } = stubClient({
    'v1Get People/42': () => ({ ...person }),
    'v2Patch people/42': (_p, body) => { person = { ...person, FirstName: body.firstName }; },
    'v2Get people/42': () => ({ id: 42, firstName: person.FirstName, lastName: person.LastName }),
  });
  const args = { id: 42, firstName: 'New', reason: 'Fix a typo in the first name' };

  const preview = await run('update_person', updatePerson, client, { ...args });
  check('update_person: first call is a preview', preview.phase === 'preview', preview);
  check('update_person: preview carries a token', typeof preview.confirmation_token === 'string');
  check('update_person: preview shows the before-state', preview.before_snapshot?.FirstName === 'Old', preview.before_snapshot);
  check('update_person: preview wrote nothing', writes().length === 0, writes());

  await rejects(
    'update_person: token with changed arguments is refused',
    () => run('update_person', updatePerson, client, { ...args, firstName: 'Other', confirmation_token: preview.confirmation_token }),
    /token mismatch/i
  );
  await rejects(
    'update_person: token with a changed reason is refused',
    () => run('update_person', updatePerson, client, { ...args, reason: 'A different reason', confirmation_token: preview.confirmation_token }),
    /token mismatch/i
  );
  check('update_person: refused calls wrote nothing', writes().length === 0, writes());

  const exec = await run('update_person', updatePerson, client, { ...args, confirmation_token: preview.confirmation_token });
  check('update_person: second call executes', exec.phase === 'executed' && exec.success === true, exec);
  check('update_person: exactly one write (the PATCH)', writes().length === 1 && writes()[0].method === 'v2Patch', writes());
  check('update_person: read-back verified', exec.verified === true, exec);
  check('update_person: keeps the person field in the result', exec.person?.firstName === 'New', exec.person);

  const recs = ledger().filter((r) => r.tool === 'update_person');
  const prev = recs.find((r) => r.phase === 'preview');
  const ex = recs.find((r) => r.phase === 'executed');
  const denied = recs.filter((r) => r.phase === 'denied');
  check('update_person: preview ledgered with reason', prev?.reason === args.reason, prev);
  check('update_person: executed ledgered with reason + snapshot + verified', ex?.reason === args.reason && !!ex?.snapshotRef && ex?.result?.verified === true, ex);
  check('update_person: executed body is PascalCase (restorable)', ex?.payload?.body?.FirstName === 'New', ex?.payload);
  check('update_person: both refusals ledgered as denied', denied.length === 2 && denied.every((d) => /token mismatch/i.test(d.denial)), denied);
  check('update_person: denied record names the target', denied[0]?.target?.entityType === 'Person' && String(denied[0]?.target?.id) === '42', denied[0]?.target);

  // Missing / blank reason is refused before any Rock call.
  const { client: c2, calls: calls2 } = stubClient({});
  await rejects('update_person: missing reason refused', () => run('update_person', updatePerson, c2, { id: 42, firstName: 'X' }), /requires a non-empty "reason"/);
  await rejects('update_person: blank reason refused', () => run('update_person', updatePerson, c2, { id: 42, firstName: 'X', reason: '   ' }), /requires a non-empty "reason"/);
  check('update_person: missing reason made no Rock calls', calls2.length === 0, calls2);
  const reasonDenials = ledger().filter((r) => r.phase === 'denied' && /non-empty "reason"/.test(r.denial ?? ''));
  check('update_person: missing-reason refusals ledgered', reasonDenials.length === 2, reasonDenials.length);
}

// ---------------------------------------------------------------- remove_group_member
{
  let exists = true;
  const member = { Id: 900, Guid: 'bbbbbbbb-0000-0000-0000-000000000900', GroupId: 7, PersonId: 42, GroupRoleId: 3, GroupMemberStatus: 1, IsArchived: false };
  const { client, writes } = stubClient({
    'v2Search': () => (exists ? [{ id: 900 }] : []),
    'v1Get GroupMembers/900': (p) => { if (!exists) throw notFound(p); return { ...member }; },
    'v1Delete GroupMembers/900': () => { exists = false; },
  });
  const args = { groupId: 7, personId: 42, reason: 'Person asked to leave the group' };

  const preview = await run('remove_group_member', removeGroupMember, client, { ...args });
  check('remove_group_member: first call is a preview', preview.phase === 'preview', preview);
  check('remove_group_member: preview shows the member row', preview.before_snapshot?.Id === 900, preview.before_snapshot);
  check('remove_group_member: preview wrote nothing', writes().length === 0);

  await rejects(
    'remove_group_member: forged token refused',
    () => run('remove_group_member', removeGroupMember, client, { ...args, confirmation_token: 'f'.repeat(64) }),
    /token mismatch/i
  );
  check('remove_group_member: forged token wrote nothing', writes().length === 0);

  const exec = await run('remove_group_member', removeGroupMember, client, { ...args, confirmation_token: preview.confirmation_token });
  check('remove_group_member: executes with the token', exec.phase === 'executed' && exec.success === true, exec);
  check('remove_group_member: one DELETE', writes().length === 1 && writes()[0].method === 'v1Delete', writes());
  check('remove_group_member: read-back verified (row gone)', exec.verified === true && exec.removal === 'deleted', exec);

  const ex = ledger().find((r) => r.tool === 'remove_group_member' && r.phase === 'executed');
  check('remove_group_member: executed ledger record is a delete with snapshot', ex?.verb === 'delete' && ex?.payload?.action === 'deleted' && !!ex?.snapshotRef, ex);
  check('remove_group_member: reason on the ledger record', ex?.reason === args.reason, ex?.reason);
  const denied = ledger().filter((r) => r.tool === 'remove_group_member' && r.phase === 'denied');
  check('remove_group_member: forged token ledgered as denied', denied.length === 1, denied);

  // rock_restore can undo it: list says restorable (recreate), preview issues a token, execute re-POSTs.
  const { rockRestore } = await load('tools/rock-restore.js');
  const { client: rc, writes: rw } = stubClient({
    'executeSql': () => [],
    'v1Post GroupMembers': () => 901,
    'v1Get GroupMembers/901': () => ({ ...member, Id: 901 }),
  });
  const list = await rockRestore(rc, {});
  const row = list.entries.find((e) => e.auditId === ex.auditId);
  check('rock_restore: lists the removal as restorable', row?.restorable === true && /Re-POST/.test(row?.restore_action ?? ''), row);
  const rArgs = { audit_id: ex.auditId, reason: 'Removed the wrong person' };
  const rPrev = await runWriteTool('rock_restore', rArgs, () => rockRestore(rc, rArgs));
  check('rock_restore: preview for the removal', rPrev.phase === 'preview' && typeof rPrev.confirmation_token === 'string', rPrev);
  const rExec = await runWriteTool('rock_restore', { ...rArgs, confirmation_token: rPrev.confirmation_token }, () =>
    rockRestore(rc, { ...rArgs, confirmation_token: rPrev.confirmation_token }));
  check('rock_restore: recreates the member and verifies it', rExec.phase === 'executed' && rExec.newId === 901 && rExec.verified === true, rExec);
  check('rock_restore: one POST', rw().length === 1 && rw()[0].method === 'v1Post', rw());
  await rejects('rock_restore: missing reason refused when audit_id given', () => runWriteTool('rock_restore', { audit_id: ex.auditId }, () => rockRestore(rc, { audit_id: ex.auditId })), /non-empty "reason"/);
}

done('two-phase.test.mjs');
