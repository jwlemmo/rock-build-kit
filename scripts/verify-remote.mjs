import {Client} from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
const url=new URL(process.argv[2]);
if(url.protocol!=='https:')throw new Error('Use the HTTPS MCP URL.');
if(!process.env.MCP_BEARER_TOKEN)throw new Error('Set MCP_BEARER_TOKEN privately in the environment.');
const client=new Client({name:'rock-kit-verifier',version:'1.0.0'});
try {
 await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${process.env.MCP_BEARER_TOKEN}`}}}));
 const {tools}=await client.listTools();console.log(`PASS: MCP handshake; ${tools.length} tools available. No Rock write called.`);
}finally{await client.close();}
