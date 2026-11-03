#!/usr/bin/env node
// READ-ONLY. Renders a Lava template through Rock's own engine (/api/Lava/RenderTemplate) against
// live data — {% sql %} included — so you can prove an email body / block / query before any write,
// or render old + new and `diff` them.
// Usage: node tools/render-lava.mjs <templateFile> <outHtml> [--prod]    (default = dev)
// Templates that read `Workflow | Attribute:...` must have those swapped for literal assigns first —
// there is no Workflow object outside a running workflow.
import fs from 'node:fs';
import { rockEnv } from './_env.mjs';

const argv = process.argv.slice(2);
const isProd = argv.includes('--prod');
const [tplFile, outFile] = argv.filter(a => !a.startsWith('--'));
if (!tplFile || !outFile) { console.error('usage: node tools/render-lava.mjs <tpl> <out.html> [--prod]'); process.exit(1); }
const tpl = fs.readFileSync(tplFile, 'utf8');
if (tpl.includes('Workflow | Attribute')) console.error('WARN: template reads Workflow attributes — they will render empty here');

const { BASE, KEY } = rockEnv(isProd);
// Content-Type MUST be text/plain with the RAW template as the body. Posting JSON.stringify(tpl)
// makes Rock read the JSON escaping literally — every " arrives as \" and a {% sql %} block dies
// with "Incorrect syntax near '\'", which reads like a SQL bug and isn't.
const r = await fetch(`${BASE}/api/Lava/RenderTemplate`, {
  method: 'POST', headers: { 'Authorization-Token': KEY, 'Content-Type': 'text/plain' }, body: tpl });
const text = await r.text();
if (!r.ok) { console.error(`${r.status} ${text.slice(0, 600)}`); process.exit(2); }
let html = text;
try { html = JSON.parse(text); } catch { /* already raw */ }
// Rock answers HTTP 200 even when Lava/SQL fails — the error is inline in the HTML.
if (/Lava Error|Liquid error|Rock SQL/i.test(html)) console.error('WARN: rendered output contains an inline Lava/SQL error');
fs.writeFileSync(outFile, html);
console.error(`${isProd ? 'PROD' : 'DEV'} rendered ${tplFile} -> ${outFile} (${html.length} chars)`);
