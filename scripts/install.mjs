import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,fail} from './env.mjs';
const args=process.argv.slice(2);
if(args.includes('--help')) {
 console.log('node scripts/install.mjs [--skip-browser] [--skip-skills] [--register codex|claude|both]\nBuilds locally; never reads existing credentials or changes Rock. Same-name user MCP entries require manual conflict resolution.'); process.exit(0);
}
function run(command,args,cwd=ROOT) {
 const result=spawnSync(command,args,{cwd,stdio:'inherit',shell:process.platform==='win32' && command.endsWith('.cmd')});
 if(result.error) throw result.error;
 if(result.status!==0) throw new Error(`${command} failed (${result.status})`);
}
function writeNew(file,text) {if(!fs.existsSync(file)) fs.writeFileSync(file,text,{mode:0o600});}
try {
 if(Number(process.versions.node.split('.')[0])<22) throw new Error('Install Node.js 22+ first.');
 const register=args.includes('--register') ? args[args.indexOf('--register')+1] : undefined;
 if(register && !['codex','claude','both'].includes(register)) throw new Error('--register must be codex, claude or both');
 const npm=process.platform==='win32'?'npm.cmd':'npm';
 run(npm,['ci'],path.join(ROOT,'mcp'));run(npm,['run','build'],path.join(ROOT,'mcp'));
 if(!args.includes('--skip-browser')) {
  run(npm,['ci'],path.join(ROOT,'tools/rock-ui'));
  run(process.execPath,[path.join(ROOT,'tools/rock-ui/node_modules/playwright/cli.js'),'install','chromium']);
 }
 fs.mkdirSync(path.join(ROOT,'local'),{recursive:true,mode:0o700});
 const servers=Object.fromEntries(['prod','dev'].map(name=>[name==='prod'?'rock-rms-v2':'rock-rms-dev',{command:process.execPath,args:[path.join(ROOT,'scripts/run.mjs'),'--env',name]}]));
 const conf=JSON.stringify({mcpServers:servers},null,2)+'\n';
 const mcpFile=path.join(ROOT,'.mcp.json');
 const existing=fs.existsSync(mcpFile)?JSON.parse(fs.readFileSync(mcpFile,'utf8')):{};
 for(const [name,entry] of Object.entries(servers)) {
  if(existing.mcpServers?.[name] && JSON.stringify(existing.mcpServers[name])!==JSON.stringify(entry)) throw new Error(`Existing ${mcpFile} has conflicting ${name}; review it manually.`);
 }
 fs.writeFileSync(mcpFile,JSON.stringify({...existing,mcpServers:{...existing.mcpServers,...servers}},null,2)+'\n');
 fs.writeFileSync(path.join(ROOT,'local/claude-desktop.json'),conf);
 fs.writeFileSync(path.join(ROOT,'local/codex.toml'),Object.entries(servers).map(([name,s])=>`[mcp_servers.${name}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args)}\n`).join('\n'));
 if(!args.includes('--skip-skills')) {
  for(const target of ['.claude/skills','.agents/skills']) {
   fs.mkdirSync(path.join(ROOT,target),{recursive:true});
   for(const name of fs.readdirSync(path.join(ROOT,'skills'))) {
    const dest=path.join(ROOT,target,name);
    if(fs.existsSync(dest)) {console.log(`Preserving installed skill ${dest}`);continue;}
    fs.cpSync(path.join(ROOT,'skills',name),dest,{recursive:true});
    fs.writeFileSync(path.join(dest,'KIT-LOCATION.txt'),ROOT+'\n');
    for(const dir of ['reference','mcp']) {
      const src=path.join(ROOT,dir==='mcp'?'mcp/reference':'reference');
      const out=path.join(dest,dir==='mcp'?'mcp/reference':'reference');
      if(!fs.existsSync(out)) fs.cpSync(src,out,{recursive:true});
    }
   }
  }
 }
 if(register) for(const client of register==='both'?['codex','claude']:[register]) {
  // Use CLI registration, preserving unrelated config. Refuse conflicts rather than replacing another church's connection.
  for(const [name,s] of Object.entries(servers)) {
   const get=spawnSync(client,['mcp','get',name],{encoding:'utf8'});
   if(get.error) throw new Error(`${client} CLI is not installed/on PATH; use generated local config instead.`);
   if(get.status===0) throw new Error(`${client} already has ${name}. Review it in client settings; no entry was overwritten.`);
   const add=client==='claude'?['mcp','add','--scope','user',name,'--',s.command,...s.args]:['mcp','add',name,'--',s.command,...s.args];
   run(client,add);
  }
 }
 console.log('Build and local configuration ready. Read SETUP.md, create your private environment files, then run doctor. No Rock connection or write was attempted.');
} catch(error) {fail(error);}
