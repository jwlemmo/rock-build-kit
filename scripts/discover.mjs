import fs from 'node:fs';import path from 'node:path';
import {ROOT,loadTarget,targetName,request,fail} from './env.mjs';
try {
 const name=targetName(),env=loadTarget(name), output={target:name,host:new URL(env.ROCK_API_URL).hostname,checked:new Date().toISOString(),metadata:{}};
 let failed=0;
 for(const [label,route] of Object.entries({layouts:'/Layouts?$select=Id,Name,SiteId',htmlBlockTypes:"/BlockTypes?$filter="+encodeURIComponent("Path eq '~/Blocks/Cms/HtmlContent.ascx'")+ '&$select=Id,Name,Path',entityTypes:'/EntityTypes?$select=Id,Name',controllers:'/RestControllers?$select=Id,Name,ClassName'})) {
  try{output.metadata[label]=await request(env,route);console.log(`PASS ${label}`);}catch(e){output.metadata[label]={error:e.message};failed++;console.log(`FAIL ${label}: ${e.message}`);}
 }
 fs.mkdirSync(path.join(ROOT,'local'),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(ROOT,`local/discovery-${name}.json`),JSON.stringify(output,null,2)+'\n',{mode:0o600});
 console.log(`Saved local/discovery-${name}.json (metadata only). Choose and review IDs before using them.`);if(failed)process.exitCode=1;
}catch(e){fail(e);}
