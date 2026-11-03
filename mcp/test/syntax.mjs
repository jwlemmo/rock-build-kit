import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
let count=0;
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','dist','.git','.claude','.agents','local','logs'].includes(entry.name))continue;const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.name.endsWith('.mjs')){const run=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);count++;}}}
walk(root);
// The helper must show help without credentials or a live browser session.
if(fs.existsSync(path.join(root,'tools/rock-ui/node_modules/playwright'))){const run=spawnSync(process.execPath,[path.join(root,'tools/rock-ui/rock-ui.mjs'),'help'],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/cache clear/);}
console.log(`Syntax checked ${count} scripts; helper help works without credentials.`);
