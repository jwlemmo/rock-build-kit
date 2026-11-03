import {loadTarget,targetName,request,fail} from './env.mjs';
try {
 const name=targetName(), env=loadTarget(name); let failures=0;
 console.log(`Read-only checks: ${name}, ${new URL(env.ROCK_API_URL).hostname}`);
 const tests=[
  ['Rock version',()=>request(env,'/Utility/GetRockSemanticVersionNumber')],
  ['REST key identity',()=>request(env,'/People/GetCurrentPerson')],
  ['v2 campus read',()=>request(env,'/v2/models/campuses/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:1})})],
  ['plain Lava render',async()=>{const v=await request(env,'/Lava/RenderTemplate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify('rock-kit-ready')});let plain=v;try{plain=JSON.parse(v);}catch{}if(String(plain).trim()!=='rock-kit-ready')throw new Error('Unexpected Lava output');}],
  ['SQL through Lava',async()=>{const v=await request(env,'/Lava/RenderTemplate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify('{% sql %}SELECT 1 AS Ready{% endsql %}{{ results | ToJSON }}')});if(!/"Ready"\s*:\s*1/.test(String(v).replaceAll('&quot;','"'))) throw new Error('Sql did not execute; inspect permissions and enabled Lava commands.');}],
 ];
 for(const [label,fn] of tests) {try {await fn();console.log(`PASS ${label}`);}catch(e){failures++;console.log(`FAIL ${label}: ${e.message}`);}}
 if(failures)process.exitCode=1;
 console.log('No returned person/campus details were printed. No writes were sent.');
} catch(error){fail(error);}
