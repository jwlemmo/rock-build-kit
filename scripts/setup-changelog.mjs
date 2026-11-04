import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT} from './env.mjs';

export function prepareChangelog(directory, repository, {publish=false, run=execFileSync}={}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository) || repository.endsWith('/.git')) throw new Error('Use OWNER/REPOSITORY, without a URL or .git suffix.');
  const destination=path.resolve(directory);
  if(fs.existsSync(destination)) throw new Error('Choose a new directory; existing folders are never overwritten.');
  if(publish) run('gh',['auth','status'],{stdio:'pipe'});
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  fs.cpSync(path.join(ROOT,'templates/changelog'),destination,{recursive:true});
  fs.writeFileSync(path.join(destination,'repository.json'),JSON.stringify({repository,visibility:'private'},null,2)+'\n');
  run('git',['init','-b','main'],{cwd:destination,stdio:'pipe'});
  if(publish){
    // Stage only the known template files. Never stage arbitrary neighboring files.
    run('git',['add','README.md','AGENTS.md','.gitignore','open/.gitkeep','changes/.gitkeep','repository.json'],{cwd:destination,stdio:'pipe'});
    run('git',['commit','-m','Initialize private Rock change log'],{cwd:destination,stdio:'pipe'});
    run('gh',['repo','create',repository,'--private','--source',destination,'--remote','origin','--push'],{cwd:destination,stdio:'pipe'});
    const result=JSON.parse(run('gh',['repo','view',repository,'--json','isPrivate,url'],{cwd:destination,encoding:'utf8',stdio:'pipe'}));
    if(result.isPrivate!==true) throw new Error('Repository privacy verification failed. Stop and inspect repository settings.');
    console.log(`Verified private repository: ${result.url}`);
  }
  return destination;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
    if(args.includes('--help')) console.log('node scripts/setup-changelog.mjs --dir /new/folder --repo OWNER/REPOSITORY [--publish]\nDefault: local template and git initialization only. --publish creates and pushes a new PRIVATE GitHub repository using your signed-in gh account.');
    else {
      if(!args.includes('--dir')||!args.includes('--repo')||!value('--dir')||!value('--repo')) throw new Error('--dir and --repo are required.');
      console.log('Change log: '+prepareChangelog(value('--dir'),value('--repo'),{publish:args.includes('--publish')}));
      console.log('Next: follow CHANGELOG-SETUP.md to connect each Rock environment and verify the first bundle.');
    }
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
