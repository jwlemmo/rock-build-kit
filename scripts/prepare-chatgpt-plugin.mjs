import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {ROOT} from './env.mjs';
export function appId(value){let id=value;if(id.startsWith('https://')){const u=new URL(id);if(u.hostname!=='chatgpt.com')throw new Error('Expected a chatgpt.com plugin URL.');id=u.pathname.split('/').filter(Boolean).at(-1);}
 if(id?.startsWith('plugin_'))id=id.slice(7);
 if(!/^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id||''))throw new Error('Use the actual app ID (asdk_app_…), or its plugin_asdk_app_… URL/ID.');return id;}
export function prepare(value,root=ROOT){
 const id=appId(value),market=path.join(root,'local/chatgpt-marketplace'),dest=path.join(market,'plugins/rock-build-kit');
 if(fs.existsSync(dest))throw new Error('Generated plugin exists. Review/remove the generated local folder before replacing it.');
 fs.mkdirSync(dest,{recursive:true,mode:0o700});
 for(const name of ['AGENTS.md','CLAUDE.md','CHATGPT-WORK.md','START-HERE.md','SETUP.md','SECURITY.md','PORTABILITY.md']) {if(fs.existsSync(path.join(root,name)))fs.copyFileSync(path.join(root,name),path.join(dest,name));}
 for(const dir of ['skills','reference'])fs.cpSync(path.join(root,dir),path.join(dest,dir),{recursive:true});
 fs.mkdirSync(path.join(dest,'mcp'),{recursive:true});fs.cpSync(path.join(root,'mcp/reference'),path.join(dest,'mcp/reference'),{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin.json'),'utf8'));manifest.extensions['com.openai'].apps='./.app.json';
 fs.writeFileSync(path.join(dest,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
 fs.mkdirSync(path.join(dest,'.codex-plugin'));fs.writeFileSync(path.join(dest,'.codex-plugin/plugin.json'),JSON.stringify({name:manifest.name,version:manifest.version,description:manifest.description,skills:'./skills/',apps:'./.app.json',interface:manifest.extensions['com.openai'].interface},null,2)+'\n');
 fs.writeFileSync(path.join(dest,'.app.json'),JSON.stringify({apps:{'rock-rms':{id,required:true}}},null,2)+'\n');
 fs.writeFileSync(path.join(dest,'README.md'),'# Connected Rock Build Kit\nThis package references your registered ChatGPT app. It contains no local MCP command or secrets. Install the app/plugin in both Chat and Work; call get_build_guide for instructions. Local browser/admin scripts require a separate local host.\n');
 const catalog={name:'rock-chatgpt',interface:{displayName:'Rock for Chat and Work'},plugins:[{name:manifest.name,source:{source:'local',path:'./plugins/rock-build-kit'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
 fs.mkdirSync(path.join(market,'.agents/plugins'),{recursive:true});fs.writeFileSync(path.join(market,'.agents/plugins/marketplace.json'),JSON.stringify(catalog,null,2)+'\n');
 return {market,dest,id};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const a=process.argv.slice(2);if(a.includes('--help'))console.log('node scripts/prepare-chatgpt-plugin.mjs --app-id <actual-app-id-or-plugin-URL>');else {const i=a.indexOf('--app-id');if(i<0)throw new Error('--app-id is required after creating the custom MCP plugin in ChatGPT.');const result=prepare(a[i+1]);console.log('Generated '+result.market+'. No secrets or desktop-only MCP config included. See CHATGPT-WORK.md for import instructions.');}}catch(e){console.error(e.message);process.exitCode=1;}
