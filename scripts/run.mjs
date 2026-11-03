import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, loadTarget, targetName, fail } from './env.mjs';
try {
  const name = targetName();
  const target = loadTarget(name);
  const logDir = path.join(ROOT,'mcp','logs',name);
  fs.mkdirSync(logDir,{recursive:true, mode:0o700});
  const env = {...process.env};
  // Do not inherit another connection's transport/credential/log settings.
  for (const key of Object.keys(env)) if (key.startsWith('ROCK_') || ['TRANSPORT','MCP_BEARER_TOKEN','PORT'].includes(key)) delete env[key];
  Object.assign(env,target, { TRANSPORT:'stdio', ROCK_LOGS_DIR:logDir, ROCK_AUDIT_FILE:path.join(logDir,'changes.jsonl'), ROCK_MANIFEST_FILE:path.join(logDir,'manifest.json'), ROCK_MCP_LOG_FILE:path.join(logDir,'usage.jsonl') });
  const child=spawn(process.execPath,[path.join(ROOT,'mcp/dist/index.js')],{cwd:ROOT,env,stdio:'inherit'});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  child.on('error',fail);
  child.on('exit',code=>{process.exitCode=code??1;});
} catch(error) { fail(error); }
