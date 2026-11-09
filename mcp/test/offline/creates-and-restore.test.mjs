// Create-type data writes run at once and are ledgered for rock_restore; launch_workflow is
// marked not undoable; set_person_attribute is two-phase and restorable; failed writes and
// failed read-backs report an uncertain outcome and are never retried.
import { load, ledger, stubClient, notFound, check, rejects, done } from './_harness.mjs';

const { runWriteTool } = await load('safety/index.js');
const { addGroupMember } = await load('tools/groups.js');
const { launchWorkflow } = await load('tools/workflows.js');
const { setPersonAttribute } = await load('tools/attributes.js');
const { addPersonTag } = await load('tools/people.js');
const { rockRestore } = await load('tools/rock-restore.js');

const run = (tool, fn, client, args) => runWriteTool(tool, args, () => fn(client, args));

// ---------------------------------------------------------------- add_group_member (create)
{
  const { client, writes } = stubClient({
    'v2Search': (ctrl) => (ctrl === 'groupmembers' ? [] : [{ groupTypeId: 9 }]),
    'v1Post GroupMembers': () => 333,
    'v1Get GroupMembers/333': () => ({ Id: 333 }),
  });
  const args = { groupId: 7, personId: 42, roleId: 2, reason: 'New volunteer' };
  const res = await run('add_group_member', addGroupMember, client, args);
  check('add_group_member: runs at once (no preview)', res.success === true && res.groupMemberId === 333 && res.phase === undefined, res);
  check('add_group_member: one POST', writes().length === 1);
  check('add_group_member: verified', res.verified === true);
  const rec = ledger().find((r) => r.tool === 'add_group_member');
  check('add_group_member: ledgered as create with newId + reason', rec?.phase === 'create' && rec?.result?.newId === 333 && rec?.reason === 'New volunteer', rec);
  const list = await rockRestore(stubClient({}).client, {});
  const row = list.entries.find((e) => e.auditId === rec.auditId);
  check('rock_restore: add_group_member is undoable (DELETE GroupMembers/333)', row?.restorable === true && /GroupMembers\/333/.test(row?.restore_action ?? ''), row);

  // Already a member: nothing written, nothing ledgered.
  const before = ledger().length;
  const { client: c2, writes: w2 } = stubClient({ 'v2Search': (ctrl) => (ctrl === 'groupmembers' ? [{ id: 1 }] : []) });
  const noop = await run('add_group_member', addGroupMember, c2, args);
  check('add_group_member: already a member writes nothing', noop.written === false && w2().length === 0 && ledger().length === before, noop);
}

// ---------------------------------------------------------------- launch_workflow (not undoable)
{
  const { client } = stubClient({
    'v2Get workflowTypes/55': () => ({ name: 'Intake', isActive: true }),
    'v1Post': () => ({ Id: 8080, Status: 'Completed', IsPersisted: true, Name: 'Workflow From REST' }),
    'v1Get Workflows/8080': () => ({ Id: 8080, Name: 'Workflow From REST', Status: 'Completed' }),
  });
  const args = { workflowTypeId: 55, reason: 'Kick off intake for a new hire' };
  const res = await run('launch_workflow', launchWorkflow, client, args);
  check('launch_workflow: launches and verifies', res.success === true && res.workflowId === 8080 && res.verified === true, res);
  check('launch_workflow: result says it cannot be undone', res.undo?.supported === false, res.undo);
  const rec = ledger().find((r) => r.tool === 'launch_workflow');
  check('launch_workflow: ledger record marks undo unsupported', rec?.undo?.supported === false && /already run/.test(rec?.undo?.why ?? ''), rec?.undo);
  const rArgs = { audit_id: rec.auditId, reason: 'Undo the launch' };
  const r = await runWriteTool('rock_restore', rArgs, () => rockRestore(stubClient({}).client, rArgs));
  check('rock_restore: refuses to undo a launch', r.phase === 'refused' && /cannot undo launch_workflow/.test(r.reason), r);
  const denial = ledger().find((x) => x.tool === 'rock_restore' && x.phase === 'denied');
  check('rock_restore: the refusal is ledgered', !!denial && /cannot undo launch_workflow/.test(denial.denial), denial);
}

// ---------------------------------------------------------------- set_person_attribute (two-phase + restore)
{
  let stored = 'False';
  const { client, writes } = stubClient({
    'executeSql': () => [{ AttributeId: 100, AttributeValueId: 2000, Value: stored }],
    'v1Post': (path) => { stored = decodeURIComponent(path.match(/attributeValue=([^&]*)/)[1]); return null; },
  });
  const args = { personId: 42, key: 'SOM101Completed', value: true, reason: 'Finished the class' };
  const prev = await run('set_person_attribute', setPersonAttribute, client, args);
  check('set_person_attribute: preview first', prev.phase === 'preview' && prev.intended_change?.from === 'False' && prev.intended_change?.to === 'True', prev);
  check('set_person_attribute: preview wrote nothing', writes().length === 0);
  const exec = await run('set_person_attribute', setPersonAttribute, client, { ...args, confirmation_token: prev.confirmation_token });
  check('set_person_attribute: executes and verifies', exec.phase === 'executed' && exec.verified === true && stored === 'True', exec);
  const rec = ledger().find((r) => r.tool === 'set_person_attribute' && r.phase === 'executed');
  check('set_person_attribute: undo records the old value', rec?.undo?.kind === 'attribute-value' && rec?.undo?.value === 'False', rec?.undo);

  const rArgs = { audit_id: rec.auditId, reason: 'Marked the wrong person' };
  const rPrev = await runWriteTool('rock_restore', rArgs, () => rockRestore(client, rArgs));
  check('rock_restore: attribute restore preview', rPrev.phase === 'preview' && /back to|to "False"/.test(rPrev.planned_action), rPrev);
  const rExec = await runWriteTool('rock_restore', { ...rArgs, confirmation_token: rPrev.confirmation_token }, () =>
    rockRestore(client, { ...rArgs, confirmation_token: rPrev.confirmation_token }));
  check('rock_restore: attribute set back and verified', rExec.phase === 'executed' && rExec.verified === true && stored === 'False', rExec);
}

// ---------------------------------------------------------------- uncertain outcomes
{
  // The POST itself fails (e.g. a timeout): ledgered as failed, error says check before retrying.
  let posts = 0;
  const { client } = stubClient({
    'v2Search': (ctrl) => (ctrl === 'tags' ? [{ id: 5 }] : []),
    'v2Get': () => ({ guid: 'cccccccc-0000-0000-0000-000000000042' }),
    // The kit resolves the Person entity type on the connected Rock rather than assuming an id.
    'executeSql': (q) => (/Rock\.Model\.Person/.test(q) ? [{ Id: 15 }] : []),
    'v1Post TaggedItems': () => { posts++; throw new Error('Rock v1 POST TaggedItems → timeout'); },
  });
  const args = { personId: 42, tagName: 'Volunteer', reason: 'Tag new volunteer' };
  await rejects('add_person_tag: failed write reports an uncertain outcome', () => run('add_person_tag', addPersonTag, client, args), /could not be confirmed[\s\S]*never retries/);
  check('add_person_tag: the write was attempted once, not retried', posts === 1, posts);
  const rec = ledger().find((r) => r.tool === 'add_person_tag');
  check('add_person_tag: failed attempt is ledgered', rec?.result?.success === false && rec?.result?.verified === false, rec?.result);

  // The write succeeds but the read-back fails: verified:false with a note, not an error.
  const { client: c2 } = stubClient({
    'v2Search': (ctrl) => (ctrl === 'tags' ? [{ id: 5 }] : []),
    'v2Get': () => ({ guid: 'cccccccc-0000-0000-0000-000000000042' }),
    // The kit resolves the Person entity type on the connected Rock rather than assuming an id.
    'executeSql': (q) => (/Rock\.Model\.Person/.test(q) ? [{ Id: 15 }] : []),
    'v1Post TaggedItems': () => 71,
    'v1Get TaggedItems/71': () => { throw new Error('Rock v1 GET TaggedItems/71 → 500: boom'); },
  });
  const res = await run('add_person_tag', addPersonTag, c2, args);
  check('add_person_tag: failed read-back gives verified:false + note', res.verified === false && /never retries/.test(res.verification_note ?? ''), res);
}

done('creates-and-restore.test.mjs');
