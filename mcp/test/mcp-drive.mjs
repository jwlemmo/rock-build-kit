#!/usr/bin/env node
/**
 * mcp-drive.mjs — manifest-driven MCP stdio JSON-RPC driver for tool verification.
 *
 * Spawns dist/index.js as a real MCP server (stdio transport) and exercises tools via
 * tools/call, so the certification target is the full MCP surface (dispatch, schemas,
 * serialization) — not direct module imports like the older smoke tests.
 *
 * Usage:
 *   node test/mcp-drive.mjs --env-file .env.dev --manifest test/dev-manifest.json \
 *        [--lane R|W|all] [--only tool1,tool2] [--concurrency 4] \
 *        [--results logs/dev/verify.jsonl] [--var name=value ...]
 *   node test/mcp-drive.mjs --env-file .env --dump-schemas       # print tools+schemas, exit
 *
 * Manifest entry shape:
 *   { "id": "r-campuses", "tool": "list_campuses", "lane": "R", "args": {},
 *     "dependsOn": ["other-id"],            // skip unless those entries passed
 *     "resolve": [{"var":"campusId","path":"[0].id"} | {"var":"x","regex":"Id\\": (\\d+)"}],
 *     "expect": {"contains":"..."},         // optional assertion on result text
 *     "twoPhase": {"autoConfirm":true,"guard":"MCPTEST"},  // auto-confirm previews (guarded)
 *     "haltLaneOnFail": true,               // W-lane: stop the lane if this fails
 *     "timeoutMs": 60000 }
 * Args may reference resolved vars: "${var}" (whole-string refs keep the raw type).
 *
 * Safety: if any W-lane entry is scheduled, ROCK_API_URL must contain "rockdev" — the
 * write lane refuses to run against anything but the dev box. Two-phase previews are
 * auto-confirmed ONLY when the entry opts in AND the preview text contains the guard
 * substring (default MCPTEST); everything else is reported and skipped.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------- CLI ----------
const argv = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
const ENV_FILE = argVal('--env-file', '.env');
const MANIFEST = argVal('--manifest', null);
const LANE = (argVal('--lane', 'all') || 'all').toUpperCase();
const ONLY = argVal('--only', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const CONCURRENCY = Number(argVal('--concurrency', '4'));
const RESULTS = argVal('--results', 'logs/dev/verify.jsonl');
const DUMP_SCHEMAS = argv.includes('--dump-schemas');
const seedVars = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--var' && argv[i + 1]?.includes('=')) {
    const [k, ...rest] = argv[i + 1].split('=');
    const raw = rest.join('=');
    seedVars[k] = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
}

// ---------- env ----------
function loadEnvFile(p) {
  const out = {};
  const text = readFileSync(pathResolve(ROOT, p), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const fileEnv = loadEnvFile(ENV_FILE);
const isDev = /rockdev/i.test(fileEnv.ROCK_API_URL ?? '');
const childEnv = {
  ...process.env,
  ...fileEnv,
  ...(isDev
    ? {
        // rockdev's cert is expired (tracked for renewal); bypass is dev-only by construction.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        ROCK_LOGS_DIR: fileEnv.ROCK_LOGS_DIR ?? join(ROOT, 'logs', 'dev'),
      }
    : {}),
};

// ---------- MCP stdio client ----------
class McpChild {
  constructor() {
    this.proc = spawn('node', [join(ROOT, 'dist', 'index.js')], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    this.exited = new Promise((res) => this.proc.on('exit', res));
  }
  onData(d) {
    this.buf += d.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON stdout noise
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }
  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  async init() {
    const res = await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-drive', version: '1.0.0' },
      },
      20000
    );
    this.notify('notifications/initialized', {});
    return res;
  }
  async callTool(name, args, timeoutMs) {
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
  }
  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

// ---------- helpers ----------
function textOf(result) {
  const parts = (result?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean);
  return parts.join('\n');
}
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
/** dot/bracket path over parsed JSON: "items[0].id" or "[0].id" */
function jsonPath(obj, path) {
  if (obj == null) return undefined;
  const tokens = path.match(/[^.[\]]+/g) ?? [];
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(t) ? Number(t) : t];
  }
  return cur;
}
function substitute(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{([A-Za-z0-9_]+)\}$/);
    if (whole) {
      if (!(whole[1] in vars)) throw new Error(`unresolved var \${${whole[1]}}`);
      return vars[whole[1]];
    }
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => {
      if (!(k in vars)) throw new Error(`unresolved var \${${k}}`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}
function classify(message, isError) {
  const m = message ?? '';
  if (/certificate|ssl|tls|UNABLE_TO_VERIFY|CERT_/i.test(m)) return 'tls';
  if (/\b401\b/.test(m)) return 'auth401';
  if (/\b403\b/.test(m)) return 'http403';
  if (/\b404\b/.test(m)) return 'http404';
  if (/\b405\b/.test(m)) return 'http405';
  if (/\b5\d\d\b/.test(m)) return 'http5xx';
  if (/timeout/i.test(m)) return 'timeout';
  if (/unresolved var|dependency/i.test(m)) return 'dependency';
  if (/unknown tool|invalid|schema|required/i.test(m)) return 'schema';
  if (/lava|{%/i.test(m)) return 'lava';
  return isError ? 'tool-error' : 'other';
}

// ---------- main ----------
const child = new McpChild();
const initRes = await child.init().catch((e) => {
  console.error('initialize failed:', e.message);
  console.error('server stderr tail:\n' + child.stderrTail.join('\n'));
  process.exit(1);
});
const toolsRes = await child.request('tools/list', {}, 20000);
const toolNames = toolsRes.tools.map((t) => t.name);
console.log(
  `server: ${initRes.serverInfo?.name ?? '?'} v${initRes.serverInfo?.version ?? '?'} | tools: ${toolNames.length} | target: ${fileEnv.ROCK_API_URL}${isDev ? ' [DEV]' : ''}`
);

if (DUMP_SCHEMAS) {
  console.log(JSON.stringify(toolsRes.tools, null, 2));
  child.kill();
  process.exit(0);
}
if (!MANIFEST) {
  console.error('no --manifest given');
  child.kill();
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(pathResolve(ROOT, MANIFEST), 'utf8'));
let entries = manifest.filter((e) => (LANE === 'ALL' ? true : e.lane === LANE));
if (ONLY) entries = entries.filter((e) => ONLY.includes(e.tool) || ONLY.includes(e.id));

// Write-lane hard gate: never point a write lane at anything but rockdev.
if (entries.some((e) => e.lane === 'W') && !isDev) {
  console.error('REFUSING: write-lane entries scheduled but ROCK_API_URL is not rockdev.');
  child.kill();
  process.exit(1);
}

mkdirSync(dirname(pathResolve(ROOT, RESULTS)), { recursive: true });
const vars = { ...seedVars };
const results = [];
const passed = new Set();

async function runEntry(e) {
  const started = Date.now();
  const rec = { id: e.id, tool: e.tool, lane: e.lane, ok: false, ms: 0, class: '', note: '' };
  try {
    for (const dep of e.dependsOn ?? []) {
      if (!passed.has(dep)) throw new Error(`dependency ${dep} did not pass`);
    }
    if (!toolNames.includes(e.tool)) throw new Error(`unknown tool ${e.tool}`);
    const args = substitute(e.args ?? {}, vars);
    let result = await child.callTool(e.tool, args, e.timeoutMs ?? 60000);
    let text = textOf(result);
    let parsed = tryParse(text);
    rec.text = text.slice(0, 4000);

    // Two-phase auto-confirm (guarded)
    if (parsed?.confirmation_token && parsed?.phase === 'preview') {
      const guard = String(substitute(e.twoPhase?.guard ?? 'MCPTEST', vars));
      if (!e.twoPhase?.autoConfirm) {
        throw new Error(`preview returned but entry not flagged for autoConfirm`);
      }
      if (!text.includes(guard)) {
        throw new Error(`preview lacks guard "${guard}" — refusing to auto-confirm`);
      }
      const confirmArgs = { ...args, confirmation_token: parsed.confirmation_token };
      for (const k of e.twoPhase?.echo ?? []) {
        if (parsed[k] !== undefined) confirmArgs[k] = parsed[k];
      }
      result = await child.callTool(e.tool, confirmArgs, e.timeoutMs ?? 60000);
      text = textOf(result);
      parsed = tryParse(text);
    }

    if (result.isError) throw new Error(text.slice(0, 400));
    rec.text = text.slice(0, 4000);
    if (e.expect?.contains && !text.includes(e.expect.contains)) {
      throw new Error(`expectation failed: missing "${e.expect.contains}" in: ${text.slice(0, 200)}`);
    }
    if (e.expect?.regex && !new RegExp(e.expect.regex).test(text)) {
      throw new Error(`expectation regex failed: /${e.expect.regex}/ in: ${text.slice(0, 200)}`);
    }
    for (const r of e.resolve ?? []) {
      let v;
      if (r.path) v = jsonPath(parsed, r.path);
      else if (r.regex) v = text.match(new RegExp(r.regex))?.[1];
      if (v === undefined || v === null) throw new Error(`resolve failed for var ${r.var} (${r.path ?? r.regex})`);
      if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
      vars[r.var] = v;
    }
    rec.ok = true;
    rec.note = text.slice(0, 120).replace(/\s+/g, ' ');
    rec.text = text.slice(0, 4000);
    passed.add(e.id);
  } catch (err) {
    rec.class = classify(err.message, true);
    rec.note = err.message.slice(0, 400);
  }
  rec.ms = Date.now() - started;
  results.push(rec);
  appendFileSync(pathResolve(ROOT, RESULTS), JSON.stringify(rec) + '\n');
  console.log(`  [${rec.ok ? 'PASS' : 'FAIL'}] ${e.lane}/${e.tool}${e.id !== e.tool ? ` (${e.id})` : ''} ${rec.ms}ms${rec.ok ? '' : ` [${rec.class}] ${rec.note.slice(0, 160)}`}`);
}

// Lane R: waves respecting dependsOn, CONCURRENCY at a time. Lane W: strictly serial.
const rEntries = entries.filter((e) => e.lane === 'R');
const wEntries = entries.filter((e) => e.lane === 'W');

const done = new Set();
while (done.size < rEntries.length) {
  const ready = rEntries.filter(
    (e) => !done.has(e.id) && (e.dependsOn ?? []).every((d) => done.has(d) || passed.has(d))
  );
  if (!ready.length) {
    // remaining entries have unsatisfiable deps — run them to record the dependency failure
    ready.push(...rEntries.filter((e) => !done.has(e.id)));
  }
  for (let i = 0; i < ready.length; i += CONCURRENCY) {
    await Promise.all(ready.slice(i, i + CONCURRENCY).map((e) => runEntry(e)));
  }
  ready.forEach((e) => done.add(e.id));
}

let wHalted = false;
for (const e of wEntries) {
  if (wHalted) {
    const rec = { id: e.id, tool: e.tool, lane: 'W', ok: false, ms: 0, class: 'halted', note: 'lane halted by earlier failure' };
    results.push(rec);
    appendFileSync(pathResolve(ROOT, RESULTS), JSON.stringify(rec) + '\n');
    console.log(`  [SKIP] W/${e.tool} (${e.id}) — lane halted`);
    continue;
  }
  await runEntry(e);
  const last = results[results.length - 1];
  if (!last.ok && e.haltLaneOnFail) wHalted = true;
}

// ---------- summary + matrix ----------
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
const matrixPath = pathResolve(ROOT, dirname(RESULTS), 'verify-matrix.md');
const lines = [
  `# Verification matrix — ${fileEnv.ROCK_API_URL} — ${new Date().toISOString()}`,
  '',
  `| id | tool | lane | ok | ms | class | note |`,
  `|---|---|---|---|---|---|---|`,
  ...results.map(
    (r) => `| ${r.id} | ${r.tool} | ${r.lane} | ${r.ok ? '✅' : '❌'} | ${r.ms} | ${r.class} | ${r.note.replace(/\|/g, '\\|').slice(0, 140)} |`
  ),
  '',
  `**${pass} pass / ${fail} fail** (${results.length} entries)`,
];
writeFileSync(matrixPath, lines.join('\n') + '\n');
console.log(`\n== ${pass} pass / ${fail} fail — matrix: ${matrixPath} ==`);
child.kill();
process.exit(fail ? 2 : 0);
