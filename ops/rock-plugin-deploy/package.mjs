import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const [source,output]=process.argv.slice(2);if(!source||!output)throw new Error('Usage: package.mjs /staging /output.zip');
const root=fs.realpathSync(source),out=path.resolve(output),manifest=[];
if(out.startsWith(root+path.sep))throw new Error('Output must be outside staging.');
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const abs=path.join(dir,entry.name),rel=path.relative(root,abs).split(path.sep).join('/');if(entry.isSymbolicLink())throw new Error('No symlinks: '+rel);if(entry.isDirectory()){walk(abs);continue;}if(!/^(Bin\/[A-Za-z0-9_.-]+\.dll|Plugins\/[A-Za-z0-9_./-]+\.(?:js|css|html|ascx|svg|png|jpg|woff2?))$/i.test(rel))throw new Error('Unexpected package file: '+rel);manifest.push({path:rel,sha256:createHash('sha256').update(fs.readFileSync(abs)).digest('hex')});}}
walk(root);if(!manifest.some(f=>f.path.startsWith('Bin/')))throw new Error('No DLL found.');
execFileSync('python3',['-c','import zipfile,sys,pathlib; r=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(r)) for p in r.rglob("*") if p.is_file()]; z.close()',root,out]);
fs.writeFileSync(out+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');console.log('Package and SHA256 manifest written. No deployment performed.');
