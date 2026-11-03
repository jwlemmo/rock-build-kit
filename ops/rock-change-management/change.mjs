import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const [command,slug,title,author]=process.argv.slice(2);
const root=process.env.ROCK_CHANGELOG_DIR||path.join(os.homedir(),'Repositories','rock-changelog');
if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug||''))throw new Error('Use a lowercase slug; usage: open slug "Title" email | pushed slug | cancel slug');
const dir=path.join(root,'open');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,slug+'.json');
if(command==='open'){
 if(!title||!author)throw new Error('Title and operator email required.');if(fs.existsSync(file))throw new Error('Bundle already exists.');
 fs.writeFileSync(file,JSON.stringify({id:slug,title,author,status:'open',createdAt:new Date().toISOString(),targets:[],objects:[],auditIds:[],verification:[],rollback:''},null,2)+'\n',{mode:0o600});
}else if(['pushed','cancel'].includes(command)){
 const data=JSON.parse(fs.readFileSync(file,'utf8'));data.status=command==='pushed'?'pushed':'cancelled';data.closedAt=new Date().toISOString();fs.mkdirSync(path.join(root,'changes'),{recursive:true});fs.writeFileSync(path.join(root,'changes',slug+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});fs.unlinkSync(file);
}else throw new Error('Unknown command');
console.log(`Recorded ${slug}: ${command}`);
