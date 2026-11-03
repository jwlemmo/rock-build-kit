import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.cpSync(path.join(root,'guides'),path.join(root,'dist/guides'),{recursive:true});
