import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {ROOT} from './env.mjs';
const source=path.join(ROOT,'local/chatgpt-marketplace/plugins/rock-build-kit'),out=path.join(ROOT,'local/rock-build-kit-chatgpt-plugin.zip');
if(!fs.existsSync(path.join(source,'.app.json')))throw new Error('Run prepare-chatgpt-plugin.mjs with the actual app ID first.');
for(const forbidden of ['.mcp.json','mcp.json','local','.env'])if(fs.existsSync(path.join(source,forbidden)))throw new Error('Unexpected private or local-only file in generated plugin.');
const py='import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); files=[p for p in root.rglob("*") if p.is_file()]; assert all(not p.is_symlink() for p in files); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root)) for p in files]; z.close()';
const run=spawnSync(process.platform==='win32'?'python':'python3',['-c',py,source,out],{stdio:'inherit'});if(run.status!==0)throw new Error('Python 3 is required to package the plugin.');console.log(out);
