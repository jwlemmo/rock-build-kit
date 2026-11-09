// SQL UPDATE/DELETE row checks: the statement's own WHERE is counted and must match the
// snapshotQuery count; the execute runs in a transaction that rolls back when the statement
// changes more rows than the snapshot holds; both refusals are ledgered as denied.
import { load, ledger, stubClient, check, rejects, done } from './_harness.mjs';

const { runWriteTool } = await load('safety/index.js');
const { rockEdit, rockDelete, countStatementRows, guardRowCount } = await load('tools/rock-write.js');

const PERSON_COLS = ['Id', 'EmailNote', 'IsActive', 'ModifiedDateTime', 'ModifiedByPersonAliasId'].map((c) => ({
  COLUMN_NAME: c, IS_NULLABLE: 'YES', HasDefault: 0, IsIdentity: c === 'Id' ? 1 : 0, IsComputed: 0,
}));

/** Stub where COUNT(*) over the statement's WHERE returns `whereCount` and the snapshot returns `snapRows`. */
function personStub({ whereCount, snapRows, commandResult }) {
  return stubClient({
    'v1Get People/GetCurrentPerson': () => ({ Id: 1, PrimaryAliasId: 10 }),
    executeSql: (q) => {
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(q)) return PERSON_COLS;
      if (/^SELECT COUNT\(\*\) AS n FROM \[Person\]/.test(q)) return [{ n: whereCount }];
      if (/^SELECT TOP|^SELECT Id, EmailNote/.test(q)) return snapRows;
      return [];
    },
    executeSqlCommand: (sql) => {
      if (typeof commandResult === 'function') return commandResult(sql);
      return commandResult ?? 1;
    },
  });
}

// countStatementRows parsing
{
  const seen = [];
  const client = { executeSql: async (q) => { seen.push(q); return [{ n: 7 }]; } };
  check('count: UPDATE with no WHERE counts the whole table', (await countStatementRows(client, "UPDATE [Person] SET EmailNote='x'")) === 7 && seen.at(-1) === 'SELECT COUNT(*) AS n FROM [Person]', seen.at(-1));
  await countStatementRows(client, "UPDATE [Person] SET EmailNote = 'a WHERE b' WHERE Id IN (SELECT PersonId FROM [GroupMember] WHERE GroupId = 3);");
  check('count: UPDATE uses its own WHERE, ignores quoted text and subquery FROM', seen.at(-1) === 'SELECT COUNT(*) AS n FROM [Person] WHERE Id IN (SELECT PersonId FROM [GroupMember] WHERE GroupId = 3)', seen.at(-1));
  await countStatementRows(client, 'DELETE FROM [Note] WHERE Id = 5');
  check('count: DELETE FROM … WHERE', seen.at(-1) === 'SELECT COUNT(*) AS n FROM [Note] WHERE Id = 5', seen.at(-1));
  const before = seen.length;
  check('count: UPDATE … FROM join is not counted (null)', (await countStatementRows(client, 'UPDATE p SET EmailNote = 1 FROM [Person] p JOIN [GroupMember] gm ON gm.PersonId = p.Id')) === null);
  check('count: DELETE alias FROM … is not counted (null)', (await countStatementRows(client, 'DELETE n FROM [Note] n WHERE n.Id = 5')) === null);
  check('count: UPDATE TOP (n) is not counted (null)', (await countStatementRows(client, 'UPDATE TOP (5) [Person] SET EmailNote = 1')) === null);
  check('count: uncountable statements send no query', seen.length === before);
}

// guardRowCount shape
{
  const g = guardRowCount("UPDATE [Person] SET EmailNote='x' WHERE Id = 4;", 1);
  check('guard: wraps in a transaction with a rowcount check and rollback', /^BEGIN TRY BEGIN TRAN; UPDATE \[Person\] SET EmailNote='x' WHERE Id = 4; DECLARE @rock_mcp_rows INT = @@ROWCOUNT; IF @rock_mcp_rows > 1 BEGIN ROLLBACK TRAN;/.test(g) && /THROW 50000/.test(g) && /COMMIT TRAN; END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK TRAN; THROW; END CATCH$/.test(g), g);
}

// Reviewer case: UPDATE with no WHERE, snapshotQuery returns one row → refused at preview.
{
  const { client, writes } = personStub({ whereCount: 2400, snapRows: [{ Id: 1, EmailNote: null }] });
  const args = { mode: 'sql', sql: "UPDATE [Person] SET EmailNote='x'", snapshotQuery: 'SELECT TOP 1 Id, EmailNote FROM [Person]', reason: 'Set note' };
  await rejects('edit: snapshot of 1 row vs UPDATE hitting 2400 refused at preview', () => runWriteTool('rock_edit', args, () => rockEdit(client, args)), /own WHERE matches 2400 row\(s\) but snapshotQuery returned 1/);
  check('edit: nothing written', writes().length === 0, writes());
  const denied = ledger().filter((r) => r.tool === 'rock_edit' && r.phase === 'denied');
  check('edit: mismatch refusal ledgered as denied with the reason', denied.length === 1 && denied[0].reason === 'Set note' && /snapshotQuery returned 1/.test(JSON.stringify(denied[0])), denied);

  // Even with allowBulk, a snapshot that doesn't cover the rows is refused.
  const bulkArgs = { ...args, allowBulk: true };
  await rejects('edit: allowBulk does not excuse a short snapshot', () => runWriteTool('rock_edit', bulkArgs, () => rockEdit(client, bulkArgs)), /snapshotQuery returned 1/);
}

// Matching counts over the cap → bulk refusal using the statement count.
{
  const snap = Array.from({ length: 30 }, (_, i) => ({ Id: i + 1, EmailNote: null }));
  const { client, writes } = personStub({ whereCount: 30, snapRows: snap });
  const args = { mode: 'sql', sql: "UPDATE [Person] SET EmailNote='x' WHERE Id <= 30", snapshotQuery: 'SELECT Id, EmailNote FROM [Person] WHERE Id <= 30', reason: 'Set notes' };
  await rejects('edit: 30 matching rows over the cap refused', () => runWriteTool('rock_edit', args, () => rockEdit(client, args)), /would touch 30 rows, over the bulk limit of 25/);
  check('edit: nothing written (bulk)', writes().length === 0);
}

// Uncountable UPDATE (join): preview passes on the snapshot count; execute is guarded; when Rock
// reports the guard rolled back, the call is a ledgered refusal.
{
  const snapRows = [{ Id: 4, EmailNote: null }];
  const sent = [];
  const { client } = personStub({
    whereCount: 999,
    snapRows,
    commandResult: (sql) => {
      sent.push(sql);
      throw new Error("Rock SQL command error: ROCK_MCP_ROW_GUARD: the statement changed 2400 rows, more than the 1 in the snapshot; rolled back");
    },
  });
  const args = {
    mode: 'sql',
    sql: "UPDATE p SET EmailNote='x' FROM [Person] p JOIN [GroupMember] gm ON gm.PersonId = p.Id",
    snapshotQuery: 'SELECT Id, EmailNote FROM [Person] WHERE Id = 4',
    reason: 'Set note via join',
  };
  const prev = await runWriteTool('rock_edit', args, () => rockEdit(client, args));
  check('edit (join): preview shows the snapshot count and says execute is guarded', prev.phase === 'preview' && prev.rows_affected === 1 && /rolls back if it changes more than 1 row/.test(prev.row_count_check ?? ''), prev.row_count_check);
  const execArgs = { ...args, confirmation_token: prev.confirmation_token };
  await rejects('edit (join): guard rollback becomes a refusal', () => runWriteTool('rock_edit', execArgs, () => rockEdit(client, execArgs)), /Rolled back: the rock_edit UPDATE changed more rows than the 1 captured/);
  check('edit (join): the command sent was the guarded transaction with limit 1', sent.length === 1 && /^BEGIN TRY BEGIN TRAN; UPDATE p SET/.test(sent[0]) && /IF @rock_mcp_rows > 1 BEGIN ROLLBACK TRAN;/.test(sent[0]), sent);
  const recs = ledger().filter((r) => r.tool === 'rock_edit' && r.reason === 'Set note via join');
  check('edit (join): rollback ledgered as denied, no executed record', recs.some((r) => r.phase === 'denied' && /Rolled back/.test(JSON.stringify(r))) && !recs.some((r) => r.phase === 'executed'), recs.map((r) => r.phase));
}

// Happy path: counts agree, execute sends the guarded statement and verifies.
{
  const sent = [];
  const { client } = personStub({ whereCount: 1, snapRows: [{ Id: 4, EmailNote: null }], commandResult: (sql) => { sent.push(sql); return 1; } });
  const args = { mode: 'sql', sql: "UPDATE [Person] SET EmailNote='x' WHERE Id = 4", snapshotQuery: 'SELECT Id, EmailNote FROM [Person] WHERE Id = 4', reason: 'Set one note' };
  const prev = await runWriteTool('rock_edit', args, () => rockEdit(client, args));
  check('edit: preview says the statement matches the snapshot count', prev.rows_affected === 1 && /own WHERE matches the same 1 row/.test(prev.row_count_check ?? ''), prev.row_count_check);
  const exec = await runWriteTool('rock_edit', { ...args, confirmation_token: prev.confirmation_token }, () => rockEdit(client, { ...args, confirmation_token: prev.confirmation_token }));
  check('edit: executes guarded and verifies', exec.phase === 'executed' && exec.verified === true && sent.length === 1 && /IF @rock_mcp_rows > 1 /.test(sent[0]), { phase: exec.phase, verified: exec.verified, sent });
}

// DELETE: snapshot returns fewer rows than the DELETE's WHERE → refused, nothing written.
{
  const { client, writes } = personStub({ whereCount: 12, snapRows: [{ Id: 4, EmailNote: null }, { Id: 5, EmailNote: null }] });
  const args = { mode: 'sql', sql: 'DELETE FROM [Person] WHERE IsActive = 0', snapshotQuery: 'SELECT TOP 2 Id, EmailNote FROM [Person] WHERE IsActive = 0', reason: 'Purge inactive' };
  await rejects('delete: snapshot of 2 vs DELETE of 12 refused', () => runWriteTool('rock_delete', args, () => rockDelete(client, args)), /own WHERE matches 12 row\(s\) but snapshotQuery returned 2/);
  check('delete: nothing written', writes().length === 0);
  check('delete: refusal ledgered as denied', ledger().some((r) => r.tool === 'rock_delete' && r.phase === 'denied' && r.reason === 'Purge inactive'));
}

done('sql-row-guard.test.mjs');
