// Runs every offline test file in its own node process (each gets a fresh temp ledger).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n# ${f}`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit', env: { ...process.env } });
  if (r.status !== 0) failed++;
}
console.log(`\n${files.length - failed}/${files.length} offline test files passed`);
process.exit(failed ? 1 : 0);
