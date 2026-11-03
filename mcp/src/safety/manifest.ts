/**
 * Manifest — a section→key→id map of objects we created, so creates stay idempotent and
 * are cleanly revertible. Mirrors new-hire-onboarding/build/rock.mjs (recordId/readManifest).
 *
 * File: logs/manifest.json (override with ROCK_MANIFEST_FILE).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = process.env.ROCK_LOGS_DIR ?? join(__dirname, '..', '..', 'logs');
const MANIFEST_FILE = process.env.ROCK_MANIFEST_FILE ?? join(LOGS_DIR, 'manifest.json');

type Manifest = Record<string, Record<string, unknown>>;

export function readManifest(): Manifest {
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

/** Record a created object's id under section/key. Best-effort (never throws). */
export function recordCreated(section: string, key: string, id: unknown): unknown {
  try {
    const m = readManifest();
    m[section] = m[section] ?? {};
    m[section][key] = id;
    mkdirSync(dirname(MANIFEST_FILE), { recursive: true });
    writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2) + '\n');
  } catch {
    // best-effort; the audit ledger is the authoritative record
  }
  return id;
}

export { MANIFEST_FILE };
