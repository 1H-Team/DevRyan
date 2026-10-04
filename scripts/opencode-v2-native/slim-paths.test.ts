import {test,expect} from 'bun:test';import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {rewriteReviewedSlimServer} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';
import {createReviewedSlimPathHooks} from '../../packages/web/server/lib/opencode/runtime-host/native-slim-paths.js';

test('original Slim path hooks rescue paths, guard searches and rewrite patch context through checked owned IO',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..'),root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/slim-path-'));
 try{
  const entry=path.join(root,'original.mjs');await fs.writeFile(entry,rewriteReviewedSlimServer(await fs.readFile(path.join(repository,'packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js'))).contents);
  const originals=await import(pathToFileURL(entry).href),directory=path.join(root,'workspace');await fs.mkdir(directory);const file=path.join(directory,'source.txt');await fs.writeFile(file,'  exact old text  \n');
  let revoked=false,releaseRead:undefined|(()=>void),readStarted:undefined|(()=>void);const reads:string[]=[],stats:string[]=[];let blockRead=false;
  const hooks=createReviewedSlimPathHooks({originals,directory,owners:{assertCurrent:async input=>{if(input.sessionID!=='ses_owned'||input.callID!=='call_owned'||revoked)throw new Error('actual_hook_revoked');},
   stat:async(_input,file)=>{stats.push(file);if(!file.startsWith(directory))throw Object.assign(new Error('outside_missing'),{code:'ENOENT'});const stat=await fs.stat(file);return {kind:stat.isFile()?'file':stat.isDirectory()?'directory':'other'};},
   realpath:async(_input,file)=>{if(!file.startsWith(directory))throw new Error('outside_realpath');return fs.realpath(file);},
   readText:async(_input,file)=>{if(!file.startsWith(directory))throw new Error('outside_read');reads.push(file);if(blockRead){readStarted?.();await new Promise<void>(resolve=>releaseRead=resolve);}return fs.readFile(file,'utf8');},
  }});
  const input=(tool:string)=>({tool,sessionID:'ses_owned',callID:'call_owned',directory});
  const rescue={args:{filePath:path.join('/missing',path.basename(directory),'source.txt')}};
  await hooks.before(input('read'),rescue);expect(rescue.args.filePath).toBe(file);
  await expect(hooks.before(input('glob'),{args:{path:'absent'}})).rejects.toThrow('Search path does not exist:');
  const patch={args:{patchText:'*** Begin Patch\n*** Update File: source.txt\n@@\n-exact old text\n+replacement\n*** End Patch'}};
  await hooks.before(input('apply_patch'),patch);expect(patch.args.patchText).toContain('-  exact old text  ');expect(reads).toEqual([file]);expect(await fs.readFile(file,'utf8')).toBe('  exact old text  \n');
  const started=new Promise<void>(resolve=>readStarted=resolve);blockRead=true;
  const suspended=hooks.before(input('apply_patch'),{args:{patchText:'*** Begin Patch\n*** Update File: source.txt\n@@\n-exact old text\n+replacement\n*** End Patch'}});
  await started;revoked=true;releaseRead?.();await expect(suspended).rejects.toThrow('actual_hook_revoked');
  expect(stats.some(value=>value===file)).toBe(true);await expect(hooks.before({...input('read'),directory:root},{args:{filePath:file}})).rejects.toThrow('native_slim_path_location_mismatch');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
