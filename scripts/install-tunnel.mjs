import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import {ROOT} from './env.mjs';import {fileURLToPath} from 'node:url';
export function selectAsset(release,platform,arch){
 const os={darwin:'darwin',linux:'linux',win32:'windows'}[platform];const cpu={x64:'amd64',arm64:'arm64'}[arch];
 if(!os||!cpu)throw new Error('Install tunnel-client manually on this platform.');
 const name=`tunnel-client-${release.tag_name}-${os}-${cpu}.zip`;const asset=release.assets.find(a=>a.name===name);
 if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw new Error('No matching official asset with SHA256 digest; install from the official release page.');
 if(!asset.browser_download_url.startsWith(`https://github.com/openai/tunnel-client/releases/download/${release.tag_name}/`))throw new Error('Unexpected download origin.');return asset;
}
async function main(){
 if(process.argv.includes('--help')){console.log('node scripts/install-tunnel.mjs — download the official matching tunnel-client binary into local/bin, verify SHA256, and extract with Python 3.');return;}
 const dir=path.join(ROOT,'local/bin');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const executable=path.join(dir,process.platform==='win32'?'tunnel-client.exe':'tunnel-client');
 if(fs.existsSync(executable)){console.log('Existing local tunnel-client preserved: '+executable);return;}
 const res=await fetch('https://api.github.com/repos/openai/tunnel-client/releases/latest',{headers:{'User-Agent':'rock-build-kit'},signal:AbortSignal.timeout(30000)});if(!res.ok)throw new Error(`GitHub release metadata HTTP ${res.status}`);
 const release=await res.json(),asset=selectAsset(release,process.platform,process.arch);
 const archive=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(120000)});if(!archive.ok)throw new Error(`Download HTTP ${archive.status}`);
 const bytes=Buffer.from(await archive.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==asset.digest.slice(7))throw new Error('Checksum mismatch.');
 const file=path.join(dir,'download.zip');fs.writeFileSync(file,bytes,{mode:0o600});
 // Extract only the exact binary basename. Do not trust archive paths or extract any scripts.
 const code='import zipfile,sys,pathlib; z=zipfile.ZipFile(sys.argv[1]); names=[n for n in z.namelist() if pathlib.PurePosixPath(n).name==sys.argv[3] and not n.endswith("/")]; assert len(names)==1, "Expected exactly one binary"; pathlib.Path(sys.argv[2]).write_bytes(z.read(names[0]))';
 const out=spawnSync(process.platform==='win32'?'python':'python3',['-c',code,file,executable,path.basename(executable)],{stdio:'inherit'});fs.unlinkSync(file);
 if(out.status!==0)throw new Error('Python 3 is needed for extraction. Install manually from https://github.com/openai/tunnel-client/releases/latest');
 fs.chmodSync(executable,0o700);fs.writeFileSync(path.join(dir,'tunnel-release.json'),JSON.stringify({release:release.tag_name,asset:asset.name,digest:asset.digest},null,2)+'\n');
 console.log(`Verified and installed ${release.tag_name}: ${executable}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
