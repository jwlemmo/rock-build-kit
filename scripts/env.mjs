import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) throw new Error('Invalid dotenv line; use KEY=value data, not shell commands.');
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
    out[m[1]] = value;
  }
  return out;
}
export function targetName(args = process.argv.slice(2)) {
  const at = args.indexOf('--env');
  const name = at < 0 ? 'dev' : args[at + 1];
  if (!['dev','prod'].includes(name)) throw new Error('--env must be dev or prod');
  return name;
}
export function loadTarget(name) {
  const file = path.join(ROOT, 'mcp', name === 'prod' ? '.env' : '.env.dev');
  if (!fs.existsSync(file)) throw new Error(`${name} is not configured. Create ${file} privately from its example. No fallback is used.`);
  const data = readEnv(file);
  const url = new URL(data.ROCK_API_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/\/api\/?$/.test(url.pathname)) throw new Error('ROCK_API_URL must be an HTTPS URL ending in /api, without credentials or query parameters.');
  if (/example\.(com|org)|your[-.]church|your-rock|replace/i.test(url.hostname) || !data.ROCK_API_KEY || /replace|your[-_ ]?(key|rest)|placeholder/i.test(data.ROCK_API_KEY)) throw new Error('Replace example URL/key locally before connecting.');
  if (!data.ROCK_OPERATOR_EMAIL || !data.ROCK_OPERATOR_NAME) throw new Error('Set ROCK_OPERATOR_EMAIL and ROCK_OPERATOR_NAME for audit attribution.');
  data.ROCK_API_URL = url.href.replace(/\/$/, '');
  return data;
}
export async function request(data, endpoint, options={}) {
  const response = await fetch(data.ROCK_API_URL + endpoint, { ...options, redirect:'error', signal:AbortSignal.timeout(30000), headers:{ Accept:'application/json', 'Authorization-Token':data.ROCK_API_KEY, ...options.headers } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
export function fail(error) { console.error(error.message); process.exitCode=1; }
