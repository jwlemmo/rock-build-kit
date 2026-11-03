// Pure-unit tests for the push-process gate (no network): on the dev server, build writes need
// an open change bundle authored by the operator.
// Run: node test/verify-bundle-gate.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
process.env.ROCK_CHANGELOG_DIR = repo;
process.env.ROCK_OPERATOR_EMAIL = 'Op@Example.org';
process.env.ROCK_DEV_HOST = 'rock-dev.example.org';
process.env.ROCK_REQUIRE_CHANGE_BUNDLE = '1';
const { checkBundleGate, isDevTarget } = await import('../dist/safety/bundleGate.js');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const DEV = 'https://rock-dev.example.org/api';
const PROD = 'https://rock.example.org/api';
const open = join(repo, 'open');
const writeBundle = (file, body) => writeFileSync(join(open, file), typeof body === 'string' ? body : JSON.stringify(body));

check('dev host detected', isDevTarget(DEV));
check('prod host is not dev', !isDevTarget(PROD));
check('lookalike host is not dev', !isDevTarget('https://rock-dev.example.org.evil.test/api'));
check('missing url is not dev', !isDevTarget(undefined));

process.env.ROCK_API_URL = DEV;
check('enabled gate refuses missing directory', checkBundleGate('rock_create') !== null);

mkdirSync(open);
check('empty open/: rock_create refused', /^Refused/.test(checkBundleGate('rock_create') ?? ''));
for (const t of ['rock_edit', 'rock_delete', 'create_page_bundle', 'edit_block_content'])
  check(`empty open/: ${t} refused`, checkBundleGate(t) !== null);
check('read tool never gated', checkBundleGate('execute_sql') === null);
check('data write not gated', checkBundleGate('add_group_member') === null);
check('rock_restore not gated', checkBundleGate('rock_restore') === null);

writeBundle('a.json', { status: 'open', author: 'someone.else@example.org' });
check("teammate's bundle does not count", checkBundleGate('rock_create') !== null);
writeBundle('b.json', '{ not json');
check('corrupt bundle file ignored, still refused', checkBundleGate('rock_create') !== null);
writeBundle('c.json', { status: 'pushed', author: 'op@example.org' });
check('own non-open bundle does not count', checkBundleGate('rock_create') !== null);
writeBundle('d.txt', JSON.stringify({ status: 'open', author: 'op@example.org' }));
check('non-.json file ignored', checkBundleGate('rock_create') !== null);
writeBundle('e.json', { status: 'open', author: 'op@example.org' });
check('own open bundle (case-insensitive email): allowed', checkBundleGate('rock_create') === null);

rmSync(join(open, 'e.json'));
process.env.ROCK_API_URL = PROD;
check('prod target never gated', checkBundleGate('rock_edit') === null);

rmSync(repo, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
