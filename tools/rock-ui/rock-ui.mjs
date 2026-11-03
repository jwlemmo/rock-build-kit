import {loadTarget} from '../../scripts/env.mjs';
#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

function fail(msg, code = 1) { console.error(`✗ ${msg}`); process.exit(code); }

// Env file search order: $ROCK_UI_ENV_DIR, the build kit's mcp/ folder (when run from tools/rock-ui), ~/rock-mcp-server-v2.
function loadEnv(which) {
  const out = loadTarget(which);
  out.personId = out.ROCK_UI_PERSON_ID;
  if (!/^\d+$/.test(out.personId || '')) throw new Error('Set ROCK_UI_PERSON_ID to your own Person ID in the selected environment file.');
  out.base = out.ROCK_API_URL.replace(/\/api$/, '');
  return out;
}

async function rest(env, urlPath, opts = {}) {
  const u = urlPath.startsWith('http') ? urlPath : `${env.ROCK_API_URL}${urlPath}`;
  const r = await fetch(u, { ...opts, headers: { 'Authorization-Token': env.ROCK_API_KEY, ...(opts.headers || {}) } });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text };
}

async function mintToken(env, { usageLimit = 5, hours = 1 } = {}) {
  const exp = new Date(Date.now() + hours * 3600 * 1000);
  const iso = exp.toISOString().replace(/\.\d+Z$/, '').replace(/Z$/, '');
  const { status, text } = await rest(env, `/People/GetImpersonationParameter?personId=${env.personId}&expireDateTime=${encodeURIComponent(iso)}&usageLimit=${usageLimit}`);
  if (status !== 200) throw new Error(`mintToken failed: ${status}`);
  return text.trim().replace(/^["']|["']$/g, '');
}

async function withRockPage(env, fn) {
  const tok = await mintToken(env);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    const page = await ctx.newPage();
    await page.goto(`${env.base}/Admin?${tok}`, { waitUntil: 'networkidle', timeout: 60000 });
    return await fn(page, ctx);
  } finally {
    await browser.close().catch(() => {});
  }
}

function ledger(entry) {
  try {
    const dir = path.join(SCRIPT_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function hostOf(env) { return env.base.replace(/^https?:\/\//, ''); }

async function clickVisibleByText(page, selector, text, exact = true) {
  const els = await page.locator(selector, { hasText: undefined }).all();
  for (const el of els) {
    try {
      if (!(await el.isVisible())) continue;
      const t = (await el.innerText() || '').trim();
      if (exact ? t === text : t.includes(text)) { await el.click(); return el; }
    } catch {}
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  // --prod / --dev / --json may appear anywhere on the line; other --flags belong to the command
  const flags = new Set(argv.filter(a => ['--prod', '--dev', '--json'].includes(a)));
  for (const f of flags) argv.splice(argv.indexOf(f), 1);
  const envName = flags.has('--prod') ? 'prod' : 'dev';
  const jsonOut = flags.has('--json');
  const cmd = argv[0]; const args = argv.slice(1);
  if (!cmd || cmd === 'help') {
    console.log(`usage: node rock-ui.mjs [--prod|--dev] [--json] <command> ...
commands:
  cache clear
  job run <idOrName> [--wait] [--timeout <sec>]
  route save <PageRouteId>
  shortcode save <LavaShortcodeId>
  security resave <entityTypeId|page|block|attribute|restcontroller> <entityId> [--action View|Edit|Administrate]
  help`);
    return 0;
  }

  const env = loadEnv(envName);

  async function report(ok, human, detail, exitOnFail = true, code = 1) {
    console.log(jsonOut ? JSON.stringify({ env: envName, command: cmd, args, ok, ...detail }) : human);
    ledger({ env: envName, command: cmd, args, ok, detail: JSON.stringify(detail) });
    if (!ok && exitOnFail) process.exit(code);
    return ok;
  }

  if (cmd === 'cache') {
    if (args[0] !== 'clear') fail('usage: cache clear', 2);
    await withRockPage(env, async page => {
      await page.goto(`${env.base}/admin/cms/cache-manager`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.click('a[id$="btnClearCache"]');
      let ok = false;
      try {
        await page.waitForFunction(() => document.body.innerText.includes('All cached items have been cleared.'), null, { timeout: 30000 });
        ok = true;
      } catch {}
      await report(ok, ok ? `✓ cache cleared on ${envName} (${hostOf(env)})` : `✗ cache clear failed on ${envName}`, { ok });
    });
    return 0;
  }

  if (cmd === 'job') {
    if (args[0] !== 'run' || !args[1]) fail('usage: job run <idOrName> [--wait] [--timeout <sec>]', 2);
    const idOrName = args[1];
    let wait = false, timeoutSec = 900, i = 2;
    for (; i < args.length; i++) {
      if (args[i] === '--wait') wait = true;
      else if (args[i] === '--timeout') { timeoutSec = parseInt(args[++i], 10); }
    }
    let job;
    if (/^\d+$/.test(idOrName)) {
      const r = await rest(env, `/ServiceJobs/${idOrName}`);
      if (r.status !== 200 || !r.body.Id) fail(`job ${idOrName} not found`);
      job = r.body;
    } else {
      const esc = idOrName.replace(/'/g, "''");
      const r = await rest(env, `/ServiceJobs?$filter=${encodeURIComponent(`Name eq '${esc}'`)}`);
      const rows = Array.isArray(r.body) ? r.body : [];
      if (rows.length !== 1) fail(`expected exactly 1 job named '${idOrName}', found ${rows.length}`);
      job = rows[0];
    }
    const before = job.LastRunDateTime || null;
    const ok = await withRockPage(env, async page => {
      let captured = null;
      const handler = async resp => {
        const u = resp.url();
        if (u.includes('/api/v2/BlockActions/') && u.endsWith('/GetGridData')) {
          try { const j = await resp.json(); if (j && Array.isArray(j.rows)) captured = { url: u, rows: j.rows }; } catch {}
        }
      };
      page.on('response', handler);
      await page.goto(`${env.base}/admin/system/jobs`, { waitUntil: 'networkidle', timeout: 60000 });
      const deadline = Date.now() + 30000;
      while (!captured && Date.now() < deadline) await page.waitForTimeout(500);
      page.off('response', handler);
      if (!captured) { await report(false, `✗ could not capture jobs grid data`, { error: 'no grid response' }); return false; }
      const row = captured.rows.find(r => r.name === job.Name);
      if (!row) { await report(false, `✗ job row '${job.Name}' not found in grid`, { error: 'row not found' }); return false; }
      if (!row.idKey) { await report(false, `✗ row has no idKey`, { error: 'no idKey' }); return false; }
      const runUrl = captured.url.replace(/\/GetGridData$/, '/RunNow');
      const res = await page.evaluate(async ({ url, key }) => {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ __context: { pageParameters: {} }, key }) });
        return { status: r.status, text: await r.text() };
      }, { url: runUrl, key: row.idKey });
      if (res.status !== 200) { await report(false, `✗ RunNow for '${job.Name}' failed (HTTP ${res.status})`, { httpStatus: res.status }); return false; }
      if (!wait) { await report(true, `✓ job '${job.Name}' (id ${job.Id}) triggered on ${envName}`, { job: job.Name, id: job.Id, triggered: true }); return true; }
      const waitDeadline = Date.now() + timeoutSec * 1000;
      let after = null;
      while (Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 10000));
        const r2 = await rest(env, `/ServiceJobs/${job.Id}`);
        if (r2.status === 200 && r2.body.LastRunDateTime && r2.body.LastRunDateTime !== before) { after = r2.body; break; }
      }
      if (!after) { await report(false, `✗ job '${job.Name}' did not rerun within ${timeoutSec}s`, { timedOut: true }); return false; }
      const lastStatus = after.LastStatus || '';
      const msg = (after.LastStatusMessage || '').slice(0, 300);
      const okRun = lastStatus === 'Success';
      await report(okRun, okRun ? `✓ job '${job.Name}' completed: Success` : `✗ job '${job.Name}' finished with status ${lastStatus}: ${msg}`, { job: job.Name, id: job.Id, lastStatus, message: msg, ranAt: after.LastRunDateTime }, okRun);
      return okRun;
    });
    return ok ? 0 : 1;
  }

  if (cmd === 'route') {
    if (args[0] !== 'save' || !args[1]) fail('usage: route save <PageRouteId>', 2);
    const id = args[1];
    await withRockPage(env, async page => {
      let editEntity = null, saveResp = null;
      page.on('response', async resp => {
        const u = resp.url();
        if (u.includes('/api/v2/BlockActions/') && u.endsWith('/Edit')) {
          try { const j = await resp.json(); if (j && j.entity) editEntity = j.entity; } catch {}
        }
        if (u.includes('/api/v2/BlockActions/') && u.endsWith('/Save')) saveResp = { status: resp.status() };
      });
      await page.goto(`${env.base}/page/135?PageRouteId=${id}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
      const edit = await clickVisibleByText(page, 'button', 'Edit');
      if (!edit) { await report(false, `✗ no visible Edit button on page 135`, { error: 'no Edit button' }); return; }
      await page.waitForTimeout(2000);
      const save = await clickVisibleByText(page, 'button', 'Save');
      if (!save) { await report(false, `✗ no visible Save button on page 135`, { error: 'no Save button' }); return; }
      const deadline = Date.now() + 30000;
      while (!saveResp && Date.now() < deadline) await page.waitForTimeout(500);
      const ok = saveResp && saveResp.status === 200;
      await report(ok, ok ? `✓ route ${id} saved on ${envName}${editEntity && editEntity.route ? ` (route: ${editEntity.route})` : ''}` : `✗ route save failed (no 200 Save response)`, { ok, httpStatus: saveResp ? saveResp.status : null, route: editEntity ? (editEntity.route || null) : null });
    });
    return 0;
  }

  if (cmd === 'shortcode') {
    if (args[0] !== 'save' || !args[1]) fail('usage: shortcode save <LavaShortcodeId>', 2);
    const id = args[1];
    await withRockPage(env, async page => {
      let saveOk = null, sawSaveResp = false;
      page.on('response', resp => {
        const u = resp.url();
        if (u.includes('/BlockActions/') && u.endsWith('/Save')) { sawSaveResp = true; if (resp.status() === 200) saveOk = true; }
      });
      await page.goto(`${env.base}/admin/cms/lava-shortcodes/${id}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2500);
      const editBtn = await clickVisibleByText(page, 'button', 'Edit');
      let didEdit = false;
      if (editBtn) { didEdit = true; await page.waitForTimeout(2000); }
      const save = await clickVisibleByText(page, 'button, a.btn', 'Save');
      if (!save) { await report(false, `✗ no visible Save button for shortcode ${id}`, { error: 'no Save button' }); return; }
      await page.waitForTimeout(4000);
      if (saveOk === true) {
        await report(true, `✓ shortcode ${id} saved on ${envName} (block action)`, { ok: true, path: 'block-action' });
      } else {
        const bad = await page.locator('.alert-danger, .alert-validation').all();
        let badVisible = false;
        for (const b of bad) { try { if (await b.isVisible() && (await b.innerText()).trim()) { badVisible = true; break; } } catch {} }
        const ok = !badVisible;
        await report(ok, ok ? `✓ shortcode ${id} saved on ${envName} (webforms fallback)` : `✗ shortcode ${id} save showed validation/danger alert (webforms)`, { ok, path: 'webforms', sawSaveResp });
      }
    });
    return 0;
  }

  if (cmd === 'security') {
    if (args[0] !== 'resave') fail('usage: security resave <entityTypeId|page|block|attribute|restcontroller> <entityId> [--action ...]', 2);
    const alias = { page: 'Rock.Model.Page', block: 'Rock.Model.Block', attribute: 'Rock.Model.Attribute', restcontroller: 'Rock.Model.RestController' };
    let etid = args[1];
    if (etid in alias) {
      const found = await rest(env, `/EntityTypes?$filter=${encodeURIComponent("Name eq '" + alias[etid] + "'")}`);
      if (found.status !== 200 || !Array.isArray(found.body) || found.body.length !== 1) fail('Cannot uniquely resolve entity type; use the numeric ID discovered on this church.');
      etid = found.body[0].Id;
    }
    else if (!/^\d+$/.test(etid)) fail(`bad entity type '${etid}'`, 2);
    const entityId = args[2];
    if (!entityId || !/^\d+$/.test(entityId)) fail('bad entityId', 2);
    let action = 'View', i = 3;
    for (; i < args.length; i++) {
      if (args[i] === '--action') {
        action = args[++i];
        if (!['View', 'Edit', 'Administrate'].includes(action)) fail(`bad action '${action}'`, 2);
      }
    }
    await withRockPage(env, async page => {
      await page.goto(`${env.base}/Secure/${etid}/${entityId}?t=Security&pb=&sb=Done`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
      if (action !== 'View') {
        const tabs = await page.locator('ul.nav a').all();
        let clicked = false;
        for (const t of tabs) {
          try {
            if (!(await t.isVisible())) continue;
            if ((await t.innerText()).trim() === action) { await t.click(); clicked = true; break; }
          } catch {}
        }
        if (!clicked) { await report(false, `✗ tab '${action}' not found`, { error: 'no tab' }); return; }
        await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      async function readRows() {
        const rows = await page.locator('table[id$="_rGrid"] tbody tr[datakey]').all();
        return Promise.all(rows.map(async r => {
          const datakey = await r.getAttribute('datakey');
          const tds = await r.locator('td').all();
          let role = '';
          if (tds[1]) role = ((await tds[1].innerText()) || '').trim().replace(/\s+/g, ' ');
          let value = null;
          try { value = await r.locator('input[type=radio]:checked').first().getAttribute('value'); } catch {}
          return { datakey, role, value };
        }));
      }
      const start = await readRows();
      if (start.length === 0) { await report(false, `✗ no explicit rules on this entity/action — nothing to re-save`, { error: 'no rows' }); return; }
      function pickRow(rows) {
        let idx = rows.findIndex(r => r.role !== 'All Users' && r.role !== 'All Authenticated Users' && r.role !== 'All Un-Authenticated Users' && !r.role.includes('Rock Administration'));
        if (idx < 0) idx = rows.findIndex(r => r.role.includes('Rock Administration'));
        if (idx < 0) idx = 0;
        return idx;
      }
      const idx = pickRow(start);
      const target = start[idx];
      const original = target.value;
      const other = original === 'A' ? 'D' : 'A';
      async function setRadio(datakey, value) {
        const sel = `table[id$="_rGrid"] tbody tr[datakey="${datakey}"] input[type=radio][value="${value}"]`;
        // the radio's own <label> intercepts pointer events, so click the label that wraps it
        await page.locator(sel).locator('xpath=ancestor::label[1]').click({ timeout: 10000 });
        await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      await setRadio(target.datakey, other);
      await setRadio(target.datakey, original);
      let after = await readRows();
      function mismatch(rows) {
        return rows.filter(r => { const s = start.find(x => x.datakey === r.datakey); return !s || s.value !== r.value; });
      }
      let bad = mismatch(after);
      if (bad.length) {
        for (const b of bad) {
          const s = start.find(x => x.datakey === b.datakey);
          if (s) await setRadio(b.datakey, s.value);
        }
        after = await readRows();
        bad = mismatch(after);
      }
      if (bad.length) {
        ledger({ env: envName, command: cmd, args, ok: false, detail: JSON.stringify({ mismatched: bad }) });
        console.error(`✗ SECURITY RESAVE FAILED — rows did not return to original values: ${JSON.stringify(bad)}`);
        process.exit(2);
      }
      await report(true, `✓ security resaved on ${envName} (entityType ${etid}/${entityId}, action ${action}; ${start.length} rules; flipped '${target.role}')`, { entityType: etid, entityId, action, rowsBefore: start.length, rowsAfter: after.length, flipped: target.role });
    });
    return 0;
  }

  fail(`unknown command '${cmd}' — try 'help'`, 2);
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`✗ ${String(e.message).replace(/rckipid=[^\s"&]+/g, 'rckipid=<redacted>')}`);
  process.exit(1);
}