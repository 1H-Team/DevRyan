import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin,rewriteNativeAsset} from '../native-runtime-assets.mjs';
import {startSessionExecution,verifySessionExecutionLauncher} from '../../packages/harness-runtime/lib/session-execution.js';
import {Schema} from 'effect';
import {WorkerInput} from '../../packages/web/server/lib/opencode/runtime-host/worker-protocol.ts';

test('actual original AST tools run in supervised private views with permission, progress and real settlement',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..');
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/slim-ast-'));
 const launcher=path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64');
 expect(await verifySessionExecutionLauncher({launcher})).toBe(true);
 const inputs=await prepareReviewedNativeInputs(repository);
 const core=await fs.realpath(path.join(repository,'node_modules/@opencode/core'));
 const require=createRequire(path.join(core,'package.json'));
 const pty=path.join(core,'dist/chunks/credential-dajrwvna.js');
 const ptyAsset=path.join(path.dirname(require.resolve('@opencode-ai/pty-darwin-arm64/package.json')),'bin/opencode-pty');
 const photon=require.resolve('@silvia-odwyer/photon-node');
 const rewrites=new Map(inputs.rewrites);
 rewrites.set(pty,rewriteNativeAsset('pty',await fs.readFile(pty),{assetPath:ptyAsset,assetSha256:'d333339292bb9f9a739dbce9e2ababbce81b3040ea3d064b8a9b359a1c05ab61'}));
 rewrites.set(photon,rewriteNativeAsset('photon',await fs.readFile(photon)));
 try{
  const build=await Bun.build({entrypoints:[path.join(repository,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts')],
   target:'bun',outdir:path.join(root,'worker'),plugins:[reviewedNativeInputPlugin({...inputs,rewrites})]});
  if(!build.success)throw new AggregateError(build.logs,'AST worker build failed');
  const original=path.join(root,'original');await fs.mkdir(original);await fs.writeFile(path.join(original,'code.js'),"console.log('exact');\n");
  const ast=path.join(root,inputs.ast.path);await fs.copyFile(inputs.ast.source,ast);await fs.chmod(ast,0o755);
  let sequence=0;
  const invoke=async(tool,input,{deny=false,cancel=false,asset=ast,readonly=false}={})=>{
   const callRoot=path.join(root,'call-'+sequence++),view=path.join(callRoot,'view');await fs.mkdir(view,{recursive:true});
   // Real lease views have their own Git boundary; otherwise the repository's
   // ignored .cache parent makes the original CLI correctly ignore this test.
   execFileSync('git',['init','--quiet'],{cwd:view,env:process.env});
   await fs.copyFile(path.join(original,'code.js'),path.join(view,'code.js'));
   if(readonly)await fs.chmod(path.join(view,'code.js'),0o444);
   await fs.writeFile(path.join(view,'.git','probe.js'),"console.log('protected metadata');\n");
   await fs.symlink(path.join(original,'code.js'),path.join(view,'code-link.js'));
   const scratch=path.join(callRoot,'scratch');
   const request={protocol:1,tool,input,directory:view,projectDirectory:view,logicalDirectory:original,logicalProjectDirectory:original,
    scratchDirectory:scratch,config:{formatter:false},context:{sessionID:'ses_ast',messageID:'msg_ast',agent:'builder',id:'call_ast'},
    reviewedAst:{path:asset,sha256:inputs.ast.sha256}};
   Schema.decodeUnknownSync(WorkerInput)(request,{onExcessProperty:'error'});
   const lease={viewDirectory:view,workingDirectory:view,projectDirectory:original,inputs:[]};
   const events=[];let buffer='',handle;
   const launched=await startSessionExecution({launcher,lease,command:process.execPath,args:[build.outputs[0].path],
    env:{PATH:process.env.PATH},socketDirectory:null,workerBrowsers:false,interactive:true,
    onOutput:({stream,data})=>{
     if(stream!=='stdout')return;buffer+=data.toString('utf8');
     for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;
      const event=JSON.parse(line);events.push(event);
      if(event.type==='permission'){
       if(cancel){handle.cancel();continue;}
       handle.child.stdin.write(JSON.stringify({id:event.id,ok:!deny,...(deny?{error:{_tag:'Permission.BlockedError',rules:[{action:tool,resource:'*',effect:'deny'}],permission:tool,resources:['.'],reason:'fixture denial'}}:{})})+'\n');
      }
     }
    }});
   handle=launched;handle.child.stdin.write(JSON.stringify(request)+'\n');
   const timer=setTimeout(()=>handle.cancel(),15_000);
   let receipt;try{receipt=await handle.result;}finally{clearTimeout(timer);}
   expect(receipt.terminated).toBe(true);expect(receipt.confined).toBe(true);
   return {events,receipt,text:await fs.readFile(path.join(view,'code.js'),'utf8')};
  };
  const search=await invoke('ast_grep_search',{pattern:'console.log($MSG)',lang:'javascript',paths:[path.join(original,'code.js')]});
  expect(search.receipt.exitCode).toBe(0);expect(search.text).toBe("console.log('exact');\n");
  expect(search.events.find(event=>event.type==='result').result.content).toContain("console.log('exact')");
  expect(search.events.some(event=>event.type==='progress')).toBe(true);
  const wildcard=await invoke('ast_grep_search',{pattern:'console.log($MSG)',lang:'javascript',globs:['**/*.js']});
  expect(wildcard.events.find(event=>event.type==='result').result.content).not.toContain('protected metadata');
  const dry=await invoke('ast_grep_replace',{pattern:'console.log($MSG)',rewrite:'logger.info($MSG)',lang:'javascript'});
  expect(dry.text).toBe(search.text);expect(dry.events.find(event=>event.type==='result').result.content).toContain('dryRun=false');
  const replace=await invoke('ast_grep_replace',{pattern:'console.log($MSG)',rewrite:'logger.info($MSG)',lang:'javascript',dryRun:false});
  expect(replace.receipt.exitCode).toBe(0);expect({text:replace.text,result:replace.events.find(event=>event.type==='result')}).toMatchObject({text:"logger.info('exact');\n"});
  expect(await fs.readFile(path.join(original,'code.js'),'utf8')).toBe(search.text);
  const failedApply=await invoke('ast_grep_replace',{pattern:'console.log($MSG)',rewrite:'logger.info($MSG)',lang:'javascript',dryRun:false},{readonly:true});
  expect(failedApply.receipt.exitCode).not.toBe(0);expect(failedApply.events.some(event=>event.type==='result'&&event.ok===false)).toBe(true);
  const denied=await invoke('ast_grep_replace',{pattern:'console.log($MSG)',rewrite:'logger.info($MSG)',lang:'javascript',dryRun:false},{deny:true});
  expect(denied.receipt.exitCode).not.toBe(0);expect(denied.text).toBe(search.text);expect(denied.events.some(event=>event.type==='result'&&event.ok===false)).toBe(true);
  const cancelled=await invoke('ast_grep_replace',{pattern:'console.log($MSG)',rewrite:'logger.info($MSG)',lang:'javascript',dryRun:false},{cancel:true});
  expect(cancelled.receipt.cancelled).toBe(true);expect(cancelled.text).toBe(search.text);
  for(const paths of [['--follow'],['../outside'],['.git/config'],['code-link.js']]){
   const invalid=await invoke('ast_grep_search',{pattern:'console.log($MSG)',lang:'javascript',paths});
   expect(invalid.receipt.exitCode).not.toBe(0);expect(invalid.events.some(event=>event.type==='permission')).toBe(false);
  }
  for(const input of [{pattern:'console.log($MSG)',lang:'foreign'},{pattern:'console.log($MSG)',lang:'javascript',command:'foreign'}]){
   const invalid=await invoke('ast_grep_search',input);
   expect(invalid.receipt.exitCode).not.toBe(0);expect(invalid.events.some(event=>event.type==='permission')).toBe(false);
  }
  const badAsset=await invoke('ast_grep_search',{pattern:'console.log($MSG)',lang:'javascript'},{asset:path.join(root,'foreign-ast')});
  expect(badAsset.receipt.exitCode).not.toBe(0);expect(badAsset.events.some(event=>event.type==='permission')).toBe(false);
  const corruptDirectory=path.join(root,'corrupt');await fs.mkdir(corruptDirectory);
  const corruptAsset=path.join(corruptDirectory,inputs.ast.path);await fs.writeFile(corruptAsset,'tampered',{mode:0o755});
  const corrupt=await invoke('ast_grep_search',{pattern:'console.log($MSG)',lang:'javascript'},{asset:corruptAsset});
  expect(corrupt.receipt.exitCode).not.toBe(0);expect(corrupt.events.some(event=>event.type==='permission')).toBe(false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
},30_000);
