// Pure-unit regression tests for the SQL-read-path fixes (no network).
// Run: node test/verify-fixes.mjs
import { removeComments, validateSelectOnly } from '../dist/sql-validator.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

// --- removeComments: literal-aware ---
check('leading line comment stripped', !/hi/.test(removeComments('-- hi\nSELECT 1')));
check('-- inside string literal preserved', removeComments("SELECT '-- keep' AS x").includes('-- keep'));
check('block comment stripped', !/secret/.test(removeComments('SELECT /* secret */ 1')));
check('block comment inside string preserved', removeComments("SELECT '/* keep */' AS x").includes('/* keep */'));
check('doubled-quote escape preserved', removeComments("SELECT 'a''-- b' AS x").includes("a''-- b"));
check('comment does not merge adjacent tokens', /1[\s\S]*2/.test(removeComments('SELECT 1 -- c\n, 2')));

// --- validateSelectOnly: should be VALID (the false-positives we were hitting) ---
const valid = [
  'SELECT 1',
  'SELECT COUNT(*) FROM Person',
  '-- documentation line\nSELECT 1',
  ';WITH W AS (SELECT 1 AS n) SELECT n FROM W',
  'WITH W AS (SELECT 1 AS n) SELECT n FROM W',
  'DECLARE @x int = 5; SELECT @x AS v',
  'DECLARE @a int; DECLARE @b int; SELECT 1',
  'SELECT 1;',
  "SELECT Value FROM AttributeValue WHERE Value = 'a;b'",
];
for (const q of valid) check('VALID   ' + JSON.stringify(q).slice(0, 46), validateSelectOnly(q).valid);

// --- validateSelectOnly: should be INVALID (writes must still be blocked) ---
const invalid = [
  ['SELECT 1; SELECT 2', 'two independent SELECTs'],
  ['SELECT * FROM x; DELETE FROM y', 'select-then-delete'],
  ['UPDATE Person SET NickName=1', 'update'],
  ['INSERT INTO x VALUES (1)', 'insert'],
  ['DROP TABLE x', 'drop'],
  ['SELECT * FROM x; DROP TABLE y', 'select-then-drop'],
  ['EXEC sp_who', 'exec stored proc'],
  ['DELETE FROM Person', 'delete'],
];
for (const [q, why] of invalid) check('INVALID ' + why, !validateSelectOnly(q).valid);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
