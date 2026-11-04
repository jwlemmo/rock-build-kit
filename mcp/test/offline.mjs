import {spawnSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rock-offline-'));
try {
 const files=fs.readdirSync(path.join(root,'test')).filter(x=>/^verify-.*\.mjs$/.test(x)).concat('portable.mjs', 'syntax.mjs', 'chatgpt.mjs', 'changelog.mjs');
 let failed=0;
 for(const file of files){
  const env={...process.env,ROCK_LOGS_DIR:dir,ROCK_MCP_LOG:'off'};
  for(const key of ['ROCK_API_KEY','ROCK_API_URL','ROCK_SMOKE_WRITES','ROCK_AUDIT_FILE','ROCK_MANIFEST_FILE'])delete env[key];
  const run=spawnSync(process.execPath,[path.join(root,'test',file)],{cwd:root,env,encoding:'utf8',timeout:60000});
  console.log(`${run.status===0?'PASS':'FAIL'} ${file}`);
  if(run.status!==0){failed++;console.log((run.stdout||'').slice(-5000));console.log((run.stderr||'').slice(-3000));}
 }
 console.log(`${files.length-failed}/${files.length} test suites passed`);process.exitCode=failed?1:0;
}finally{fs.rmSync(dir,{recursive:true,force:true});}
