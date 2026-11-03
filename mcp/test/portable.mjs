import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn,spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'rock-portable-'));
process.env.ROCK_LOGS_DIR=scratch;
const {createPageBundle}=await import('../dist/tools/page-bundle.js');
// No production numeric ID may be used: use deliberately different IDs, verify resolution before writes.
const calls=[];
const mock={v1Get:async(p)=>{calls.push(['GET',p]);if(p==='Pages/987')return {LayoutId:543};if(p==='BlockTypes')return [{Id:321}];if(p==='EntityTypes')return [{Id:765}];return {Id:1};},v1Post:async(p,b)=>{calls.push(['POST',p,b]);return 123;},v1Patch:async(p,b)=>{calls.push(['PATCH',p,b]);}};
const bundle=await createPageBundle(mock,{name:'Portable test',parent_page_id:987,content:'test',allow_role_ids:[876]});
assert.equal(bundle.success,true);
assert.equal(calls.find(c=>c[0]==='POST'&&c[1]==='Pages')[2].LayoutId,543);
assert.equal(calls.find(c=>c[0]==='POST'&&c[1]==='Blocks')[2].BlockTypeId,321);
assert.equal(calls.find(c=>c[0]==='POST'&&c[1]==='Auths')[2].EntityTypeId,765);
let writes=0;
await assert.rejects(()=>createPageBundle({v1Get:async(p)=>p.startsWith('Pages/')?{LayoutId:1}:[],v1Post:async()=>writes++},{name:'Bad metadata',parent_page_id:1,content:'x'}),/uniquely/);
assert.equal(writes,0);
// Real stdio protocol, fake local Rock API. No church credential, no external network.
const requests=[];
const rock=http.createServer((req,res)=>{requests.push(req.url);assert.equal(req.headers['authorization-token'],'test-only-key');res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{id:987,name:'Mock Campus'}],count:1}));});
await new Promise(resolve=>rock.listen(0,'127.0.0.1',resolve));
const env={...process.env,ROCK_API_URL:`http://127.0.0.1:${rock.address().port}/api`,ROCK_API_KEY:'test-only-key',ROCK_MCP_LOG:'off',ROCK_OPERATOR_EMAIL:'test@example.org',ROCK_OPERATOR_NAME:'Test',ROCK_LOGS_DIR:scratch};
let child;let client;
try {
 client=new Client({name:'test',version:'1.0.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],env,stderr:'pipe'}));
 const {tools}=await client.listTools();assert.equal(tools.length,55);assert.equal(new Set(tools.map(t=>t.name)).size,55);
 assert(tools.find(t=>t.name==='execute_sql').annotations.readOnlyHint);
 const result=await client.callTool({name:'list_campuses',arguments:{}});assert(!result.isError);
 const before=requests.length;const refusal=await client.callTool({name:'execute_sql',arguments:{query:'DELETE FROM Person'}});assert(refusal.isError);assert.equal(requests.length,before);
 await client.close();client=undefined;
 // HTTP auth and protocol handshake using an ephemeral free port.
 const socket=http.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 child=spawn(process.execPath,[path.join(root,'dist/index.js')],{env:{...env,TRANSPORT:'http',PORT:String(port),MCP_BEARER_TOKEN:'test-only-bearer-token-123456789'},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;let ready=false;
 for(let i=0;i<60;i++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,'HTTP server starts');
 assert.equal((await fetch(base+'/mcp',{method:'POST'})).status,401);
 client=new Client({name:'http-test',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer test-only-bearer-token-123456789'}}}));
 assert.equal((await client.listTools()).tools.length,55);await client.close();client=undefined;
 client=new Client({name:'url-test',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp/test-only-bearer-token-123456789')));assert.equal((await client.listTools()).tools.length,55);
 console.log('Portable ID discovery, preflight refusal, 55-tool stdio/HTTP handshake, auth, and read-only SQL rejection passed.');
} finally {if(client)await client.close().catch(()=>{});if(child)child.kill();await new Promise(resolve=>rock.close(resolve));fs.rmSync(scratch,{recursive:true,force:true});}
