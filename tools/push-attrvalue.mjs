#!/usr/bin/env node
// WRITES. Create or update one AttributeValue from a file's exact bytes, sha-verified by readback.
// Use for template AttributeValues (email bodies, RunLava action `Value`) instead of CHAR()-encoded
// SQL surgery: execute_sql refuses literal Lava delimiters and rock_edit mode:"sql" allows one
// statement. Outside the MCP, so it is NOT ledgered — record the change per ops/rock-change-management.
// Usage: node tools/push-attrvalue.mjs <attributeId> <entityId> <file> <guid> [--prod]   (default = dev)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { rockEnv } from './_env.mjs';

const [attributeId, entityId] = process.argv.slice(2, 4).map(Number);
const [file, guid] = process.argv.slice(4, 6);
const isProd = process.argv.includes('--prod');
if (!attributeId || !entityId || !file || !guid) {
  console.error('usage: node tools/push-attrvalue.mjs <attributeId> <entityId> <file> <guid> [--prod]'); process.exit(1);
}
const { BASE, KEY } = rockEnv(isProd);
const H = { 'Authorization-Token': KEY, 'Content-Type': 'application/json' };
const value = fs.readFileSync(file, 'utf8');
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const want = sha(value);
console.log(`${isProd ? 'PROD' : 'DEV'} attr ${attributeId} entity ${entityId}  ${Buffer.byteLength(value, 'utf8')}b  ${want.slice(0, 16)}`);

const j = async (m, u, b) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};
const existing = await j('GET', `/api/AttributeValues?$filter=AttributeId eq ${attributeId} and EntityId eq ${entityId}`);
let id;
if (existing.length) { id = existing[0].Id; await j('PATCH', `/api/AttributeValues/${id}`, { Value: value }); }
else id = await j('POST', '/api/AttributeValues', { AttributeId: attributeId, EntityId: entityId, Value: value, Guid: guid });
const back = await j('GET', `/api/AttributeValues/${id}`);
if (sha(back.Value) !== want) { console.error(`MISMATCH ${sha(back.Value)}`); process.exit(2); }
console.log(`OK AttributeValue ${id} verified`);
