/**
 * Offline test harness: no network, no real ledger.
 *
 * Import this FIRST in every offline test. It points every log/ledger path at a fresh temp
 * folder (the server reads these at module load), blocks fetch, and provides a stub Rock
 * client plus small assert/ledger helpers. Tests then load the built server with load().
 */
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..');
export const TMP = mkdtempSync(join(tmpdir(), 'rock-mcp-offline-'));

process.env.ROCK_LOGS_DIR = join(TMP, 'logs');
process.env.ROCK_AUDIT_FILE = join(TMP, 'logs', 'changes.jsonl');
process.env.ROCK_MANIFEST_FILE = join(TMP, 'logs', 'manifest.json');
process.env.ROCK_MCP_LOG = 'off';
process.env.ROCK_CONFIRM_SECRET = 'offline-test-secret';
process.env.ROCK_OPERATOR_EMAIL = 'tester@example.org';
process.env.ROCK_OPERATOR_NAME = 'Offline Tester';
process.env.ROCK_API_URL = 'https://rock.example.org';
process.env.ROCK_CHANGELOG_DIR = join(TMP, 'no-changelog-here');
delete process.env.ROCK_MCP_BULK_WRITE_MAX;

globalThis.fetch = async () => {
  throw new Error('offline test: network access is blocked');
};

// The real ledger must never be touched by these tests.
const REAL_LEDGER = join(REPO, 'logs', 'changes.jsonl');
const realBefore = existsSync(REAL_LEDGER) ? statSync(REAL_LEDGER).size : -1;
export function realLedgerUntouched() {
  const now = existsSync(REAL_LEDGER) ? statSync(REAL_LEDGER).size : -1;
  return now === realBefore;
}

export async function load(rel) {
  return import(join(REPO, 'dist', rel));
}

export function ledger() {
  const f = process.env.ROCK_AUDIT_FILE;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * Stub RockClient. `routes` maps "METHOD path" (exact) or a RegExp-keyed entry list to a
 * handler (args) => value; a thrown Error simulates a Rock error. Every call is recorded.
 */
export function stubClient(handlers = {}) {
  const calls = [];
  const call = (method) => async (...args) => {
    calls.push({ method, args });
    const path = typeof args[0] === 'string' ? args[0] : '';
    const exact = handlers[`${method} ${path}`];
    if (exact) return exact(...args);
    if (handlers[method]) return handlers[method](...args);
    throw new Error(`stub: no handler for ${method} ${path}`);
  };
  const client = {
    v1Get: call('v1Get'),
    v1Post: call('v1Post'),
    v1Patch: call('v1Patch'),
    v1Delete: call('v1Delete'),
    v2Get: call('v2Get'),
    v2Search: call('v2Search'),
    v2Patch: call('v2Patch'),
    executeSql: call('executeSql'),
    executeSqlCommand: call('executeSqlCommand'),
    lavaAppPost: call('lavaAppPost'),
  };
  return { client, calls, writes: () => calls.filter((c) => /Post|Patch|Delete|Command/.test(c.method)) };
}

export function notFound(path) {
  return new Error(`Rock v1 GET ${path} → 404: Not Found`);
}

let failures = 0;
let passes = 0;
export function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}
export async function rejects(name, fn, pattern) {
  try {
    await fn();
    check(name, false, 'expected a refusal, call succeeded');
    return undefined;
  } catch (e) {
    const ok = pattern ? pattern.test(e.message) : true;
    check(name, ok, ok ? undefined : e.message);
    return e;
  }
}
export function done(file) {
  check(`${file}: real logs/changes.jsonl untouched`, realLedgerUntouched());
  console.log(`${file}: ${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}
