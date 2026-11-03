import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';import {ROOT} from './env.mjs';
const file=path.join(ROOT,'deploy/.env');
if(fs.existsSync(file)){console.log('Existing deploy/.env preserved.');process.exit(0);}
fs.writeFileSync(file,`MCP_DOMAIN=mcp.your-church.example\nROCK_API_URL=https://rock.your-church.example/api\nROCK_API_KEY=replace-locally\nROCK_OPERATOR_EMAIL=operator@your-church.example\nROCK_OPERATOR_NAME=Your Name\nMCP_BEARER_TOKEN=${randomBytes(32).toString('hex')}\n`,{mode:0o600});
console.log('Created private deploy/.env with a random MCP secret. Edit the other values locally; no secret printed.');
