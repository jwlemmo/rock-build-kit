// Release only Git-tracked source; excludes local credentials and never includes .git history.
import {execFileSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {ROOT} from './env.mjs';
const files=execFileSync('git',['ls-files','-z'],{cwd:ROOT}).toString().split('\0').filter(Boolean);
if(!process.argv.includes('--check') && execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:ROOT}).toString().trim()) throw new Error('Commit reviewed source changes before packaging; archive must match the scanned tree.');
const forbidden=/(^|\/)(node_modules|dist|logs|local|\.git|generated)(\/|$)|(^|\/)\.env(?:\.|$)(?!.*example$)|\.zip$|\.sha256$/;
const findings=[];
for(const file of files){
 if(forbidden.test(file)){findings.push(file+': forbidden release path');continue;}
 const text=fs.readFileSync(path.join(ROOT,file),'utf8');
 const checks=[[/\/Users\/[A-Za-z]/,'private absolute path'],[/\bgh[pousr]_[A-Za-z0-9]{20,}/,'GitHub credential'],[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,'private key'],[/\bsk-[A-Za-z0-9]{20,}/,'API secret'],[/(?:longhollow|jefflemmonds|jwlemmo)/i,'source organization detail']];
 for(const [pattern,label] of checks){if(pattern.test(text)&&!(['UPSTREAM.json','scripts/package.mjs'].includes(file)&&label==='source organization detail'))findings.push(file+': '+label);}
}
if(findings.length){console.error(findings.join('\n'));process.exit(1);}
if(process.argv.includes('--check')){console.log(`PASS: ${files.length} tracked source files scanned; release paths and known secret patterns clean.`);process.exit(0);}
const out=path.resolve(process.argv[2]||path.join(ROOT,'..','rock-build-kit-v1.0.0.zip'));
execFileSync('git',['archive','--format=zip','--prefix=rock-build-kit/','HEAD','-o',out],{cwd:ROOT});
fs.writeFileSync(out+'.sha256',createHash('sha256').update(fs.readFileSync(out)).digest('hex')+'  '+path.basename(out)+'\n');
console.log(out);
