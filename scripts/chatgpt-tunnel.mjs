import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT,readEnv,targetName} from './env.mjs';

export function quoteCommand(args) { return args.map(x=>'"'+String(x).replaceAll('\\','\\\\').replaceAll('"','\\"')+'"').join(' '); }
export function tunnelConfig(name, root=ROOT) {
 if(!['dev','prod'].includes(name)) throw new Error('Environment must be dev or prod.');
 const file=path.join(root,'local',`openai-${name}.env`);
 if(!fs.existsSync(file)) throw new Error(`Create ${file} from config/openai-tunnel.env.example. Keep the runtime key out of chat.`);
 const config=readEnv(file);
 if(!/^tunnel_[a-zA-Z0-9]+$/.test(config.CONTROL_PLANE_TUNNEL_ID||'')) throw new Error('Set the real CONTROL_PLANE_TUNNEL_ID.');
 const profile=`rock-${name}`;
 const profileDir=path.join(root,'local','tunnel-profiles');
 const binary=config.TUNNEL_CLIENT_BIN|| (fs.existsSync(path.join(root,'local','bin',process.platform==='win32'?'tunnel-client.exe':'tunnel-client'))?path.join(root,'local','bin',process.platform==='win32'?'tunnel-client.exe':'tunnel-client'):'tunnel-client');
 const env={...process.env};
 for(const key of Object.keys(env)) if(/^(ROCK_|OPENAI_|CONTROL_PLANE_|TUNNEL_CLIENT_|MCP_|HEALTH_|LOG_|HARPOON_|CLOUDFLARED_)/.test(key)) delete env[key];
 // Only this dedicated runtime key reaches the OpenAI client. The MCP child loads its own Rock file.
 if(config.CONTROL_PLANE_API_KEY)env.CONTROL_PLANE_API_KEY=config.CONTROL_PLANE_API_KEY;
 if(config.CONTROL_PLANE_KEYCHAIN_SERVICE){
  if(process.platform!=='darwin')throw new Error('Keychain service references require macOS.');
  const key=spawnSync('/usr/bin/security',['find-generic-password','-a',os.userInfo().username,'-s',config.CONTROL_PLANE_KEYCHAIN_SERVICE,'-w'],{encoding:'utf8'});
  if(key.status!==0)throw new Error('Cannot read the configured Keychain runtime key.');
  env.CONTROL_PLANE_API_KEY=key.stdout.trim();
 }
 if(config.CONTROL_PLANE_ORGANIZATION_ID)env.CONTROL_PLANE_ORGANIZATION_ID=config.CONTROL_PLANE_ORGANIZATION_ID;
 return {name,profile,profileDir,binary,env,config,root};
}
export function initArgs(c) {
 return ['init','--sample','sample_mcp_stdio_local','--profile',c.profile,'--profile-dir',c.profileDir,'--tunnel-id',c.config.CONTROL_PLANE_TUNNEL_ID,'--mcp-command',quoteCommand([process.execPath,path.join(c.root,'scripts/run.mjs'),'--env',c.name]),'--health-listen-addr','127.0.0.1:0'];
}
function sync(c,args,stdio='inherit') {const r=spawnSync(c.binary,args,{env:c.env,cwd:c.root,stdio});if(r.error)throw r.error;if(r.status!==0)throw new Error(`tunnel-client ${args[0]} failed (${r.status}).`);return r;}
export async function main(args=process.argv.slice(2)) {
 const command=args[0]||'help';
 if(command==='help'||args.includes('--help')) {console.log('node scripts/chatgpt-tunnel.mjs <init|doctor|run|status|service> --env dev|prod\nUses only local/openai-ENV.env. init is offline; doctor/run contact the configured OpenAI tunnel. service installs a macOS LaunchAgent; other OSes: use run with your service manager.');return;}
 const c=tunnelConfig(targetName(args));
 fs.mkdirSync(c.profileDir,{recursive:true,mode:0o700});
 if(command==='init') {
  const file=path.join(c.profileDir,c.profile+'.yaml');if(fs.existsSync(file))throw new Error(`Profile exists: ${file}. Review it before replacing it.`);
  sync(c,initArgs(c));fs.chmodSync(file,0o600);console.log('Profile ready. The Rock key stays in its own environment file.');return;
 }
 if(command==='status') {
  const f=path.join(c.root,'local',`tunnel-${c.name}-health.url`);
  if(!fs.existsSync(f))throw new Error('No runtime health URL. Start run/service first.');
  const url=new URL(fs.readFileSync(f,'utf8').trim());
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Invalid local health URL.');
  for(const endpoint of ['healthz','readyz']){const res=await fetch(new URL('/'+endpoint,url),{signal:AbortSignal.timeout(5000)});console.log(`${endpoint}: ${res.status}`);if(!res.ok)process.exitCode=1;}
  console.log('Inspect '+new URL('/ui',url));return;
 }
 if(!c.env.CONTROL_PLANE_API_KEY || /replace|example|your.key/i.test(c.env.CONTROL_PLANE_API_KEY))throw new Error('Set the OpenAI runtime key in the private local/openai-ENV.env file.');
 if(command==='doctor') {sync(c,['doctor','--profile',c.profile,'--profile-dir',c.profileDir,'--explain']);return;}
 if(command==='run') {
  const runArgs=['run','--profile',c.profile,'--profile-dir',c.profileDir,'--health.listen-addr','127.0.0.1:0','--health.url-file',path.join(c.root,'local',`tunnel-${c.name}-health.url`)];
  const child=spawn(c.binary,runArgs,{env:c.env,cwd:c.root,stdio:'inherit'});
  for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill(sig));
  child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});return;
 }
 if(command==='service') {
  if(process.platform!=='darwin')throw new Error('Use the run command with systemd/Windows Task Scheduler; automatic service installation supports macOS only.');
  const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const label=`org.rockbuildkit.tunnel.${c.name}`;const file=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
  if(fs.existsSync(file))throw new Error('Service already exists. Inspect it before replacing.');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const log=path.join(c.root,'local',`tunnel-${c.name}.log`);fs.writeFileSync(log,'',{flag:'a',mode:0o600});
  const xml=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,path.join(c.root,'scripts/chatgpt-tunnel.mjs'),'run','--env',c.name].map(x=>'<string>'+esc(x)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${esc(c.root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(path.dirname(c.binary)+':'+process.env.PATH)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>20</integer><key>StandardOutPath</key><string>${esc(log)}</string><key>StandardErrorPath</key><string>${esc(log)}</string></dict></plist>`;
  fs.writeFileSync(file,xml,{mode:0o600});
  const load=spawnSync('launchctl',['bootstrap',`gui/${process.getuid()}`,file],{stdio:'inherit'});
  if(load.status!==0)throw new Error(`LaunchAgent written but bootstrap failed: ${file}`);
  console.log(`Installed ${label}. Verify with the status command.`);return;
 }
 throw new Error('Unknown command. Use --help.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
