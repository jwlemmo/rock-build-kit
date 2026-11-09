// Dev bundle gate (the kit's configurable gate in src/safety/bundleGate.ts), routed through the
// shared write rules: when ROCK_REQUIRE_CHANGE_BUNDLE=1 and ROCK_API_URL's host is ROCK_DEV_HOST,
// build writes need an open change bundle by the operator; production, data writes, and
// installs that never turned the gate on are not gated. Refusals are ledgered.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, ledger, stubClient, check, rejects, done, load } from './_harness.mjs';

// bundleGate.ts reads ROCK_DEV_HOST once at module load, so set it before loading.
process.env.ROCK_DEV_HOST = 'rock-dev.example.org';
const changelog = join(TMP, 'rock-changelog');
const openDir = join(changelog, 'open');
process.env.ROCK_CHANGELOG_DIR = changelog;

const { runWriteTool, checkBundleGate, isDevTarget, BUNDLE_GATED_TOOLS } = await load('safety/index.js');
const { rockCreate } = await load('tools/rock-write.js');

const createArgs = { mode: 'rest', controller: 'DefinedValues', body: { DefinedTypeId: 1, Value: 'x' }, reason: 'Add a value' };
const restClient = () => stubClient({ 'v1Post DefinedValues': () => 77, 'v1Get DefinedValues/77': () => ({ Id: 77 }) });

check('gate: gated tools match the kit', ['rock_create', 'rock_edit', 'rock_delete', 'create_page_bundle', 'edit_block_content'].every((t) => BUNDLE_GATED_TOOLS.has(t)) && BUNDLE_GATED_TOOLS.size === 5);

// Gate off (the default): never gated, even on the dev host with no bundle folder.
delete process.env.ROCK_REQUIRE_CHANGE_BUNDLE;
process.env.ROCK_API_URL = 'https://rock-dev.example.org/api';
check('gate: off by default', checkBundleGate('rock_create') === null);

process.env.ROCK_REQUIRE_CHANGE_BUNDLE = '1';

// Production: never gated.
process.env.ROCK_API_URL = 'https://rock.example.org/api';
mkdirSync(openDir, { recursive: true });
check('gate: prod is not a dev target', isDevTarget() === false);
check('gate: prod not gated even with an empty open/ folder', checkBundleGate('rock_create') === null);

// Dev, open/ folder exists, no bundle → refused and ledgered.
process.env.ROCK_API_URL = 'https://rock-dev.example.org/api';
check('gate: configured dev host is a dev target', isDevTarget() === true);
{
  const { client, calls } = restClient();
  await rejects('gate: dev build write refused without an open bundle', () => runWriteTool('rock_create', createArgs, () => rockCreate(client, createArgs)), /no open change bundle/);
  check('gate: nothing sent to Rock', calls.length === 0);
  const denied = ledger().filter((r) => r.phase === 'denied' && /no open change bundle/.test(r.denial ?? ''));
  check('gate: refusal ledgered as denied', denied.length === 1 && denied[0].tool === 'rock_create', denied);
}

// Data writes are not gated.
check('gate: add_note is not a gated tool', checkBundleGate('add_note') === null);

// Someone else's bundle does not count; a cancelled one does not count.
writeFileSync(join(openDir, 'other.json'), JSON.stringify({ status: 'open', author: 'someone@else.example.org' }));
writeFileSync(join(openDir, 'mine-cancelled.json'), JSON.stringify({ status: 'cancelled', author: 'tester@example.org' }));
check("gate: another person's open bundle does not unlock", typeof checkBundleGate('rock_create') === 'string');

// Own open bundle → allowed, write runs.
writeFileSync(join(openDir, 'mine.json'), JSON.stringify({ status: 'open', author: 'Tester@Example.org' }));
{
  const { client, writes } = restClient();
  const res = await runWriteTool('rock_create', createArgs, () => rockCreate(client, createArgs));
  check('gate: own open bundle unlocks the write', res.success === true && res.newId === 77 && writes().length === 1, res);
  check('gate: create read-back verified', res.verified === true, res);
}

// Gate on but no changelog folder: the kit refuses and says to create it (fail closed).
rmSync(changelog, { recursive: true, force: true });
{
  const msg = checkBundleGate('rock_create');
  check('gate: missing changelog folder is refused when the gate is on', typeof msg === 'string' && msg.includes('open a change bundle'), msg);
}

done('bundle-gate.test.mjs');
