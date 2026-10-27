import {expect, test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createNativeClaudeTransportHost} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-transport-host.js';
import type {NativeProviderBoot} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-worker-protocol.js';
import {prepareSupervisedController} from '../../packages/web/server/lib/opencode/runtime-host/native-process.js';

const repository = path.resolve(import.meta.dirname, '../..');
const launcher = path.join(repository, 'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64');

test.skipIf(process.platform !== 'darwin')('an inherited controller sandbox refuses a nested supervisor before its command starts', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-claude-nested-')));
  try {
    const bundle = path.join(root, 'bundle'), global = path.join(bundle, 'global');
    const globals = {home:path.join(global,'home'),data:path.join(global,'data'),state:path.join(global,'state'),cache:path.join(global,'cache'),
      bin:path.join(global,'bin'),log:path.join(global,'log'),repos:path.join(global,'repos'),tmp:path.join(global,'tmp'),config:path.join(bundle,'config','opencode')};
    const databaseDirectory = path.join(bundle, 'opencode');
    for (const directory of [databaseDirectory, ...Object.values(globals)]) await fs.mkdir(directory, {recursive: true});
    const boot = {instanceID: randomUUID(), databasePath: path.join(databaseDirectory, 'opencode.db'), globals};
    const outer = await prepareSupervisedController(boot, {launcher});
    const innerRoot = path.join(globals.state!, 'provider-transport', 'fixture'), viewDirectory = path.join(innerRoot, 'worktree');
    await fs.mkdir(viewDirectory, {recursive: true});
    const scratch=path.join(innerRoot,'scratch');await fs.mkdir(scratch);
    const innerArguments=[viewDirectory,scratch,outer.profile,path.join(innerRoot,'termination.json'),'--'];
    const marker = path.join(viewDirectory, 'command-started');
    const result = spawnSync(launcher, [...outer.arguments, launcher, ...innerArguments, '/usr/bin/touch', marker], {
      cwd: databaseDirectory, encoding: 'utf8', timeout: 5000,
      env: {PATH: '/usr/bin:/bin', DEVRYAN_EXECUTION_WORKER: '1', DYLD_INSERT_LIBRARIES: `${launcher}-spawn.dylib`},
    });
    // The exact finite marker is synthetic; no live stderr or credential is read.
    expect(result.stderr).toBe('private execution directory: Operation not permitted\n');
    expect(Buffer.byteLength(result.stderr)).toBe(53);
    expect(result.status).toBe(125);
    expect(JSON.parse(await fs.readFile(outer.receiptPath, 'utf8'))).toMatchObject({terminated: true, confined: true, exitCode: 125});
    expect(JSON.parse(await fs.readFile(path.join(innerRoot, 'termination.json'), 'utf8'))).toMatchObject({terminated: true, confined: false, exitCode: 125});
    await expect(fs.access(marker)).rejects.toMatchObject({code: 'ENOENT'});
  } finally {await fs.rm(root, {recursive: true, force: true});}
}, 10000);

for(const cancel of [false,true]) test.skipIf(process.platform !== 'darwin')(`a confined worker brokers readonly execution and ${cancel?'cancellation waits for real termination':'preserves write and credential protection'}`, async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-claude-broker-')));
 let child:ReturnType<typeof spawn>|undefined,broker:ReturnType<typeof createNativeClaudeTransportHost>|undefined;
 try{
  const bundle=path.join(root,'bundle'),global=path.join(bundle,'global');
  const globals={home:path.join(global,'home'),data:path.join(global,'data'),state:path.join(global,'state'),cache:path.join(global,'cache'),bin:path.join(global,'bin'),log:path.join(global,'log'),repos:path.join(global,'repos'),tmp:path.join(global,'tmp'),config:path.join(bundle,'config','opencode')};
  const directory=path.join(root,'project'),denied=path.join(root,'denied'),storage=path.join(globals.state,'provider-transport'),databaseDirectory=path.join(bundle,'opencode');
  for(const folder of [directory,denied,storage,databaseDirectory,...Object.values(globals)])await fs.mkdir(folder,{recursive:true});
  const account=path.join(globals.home,'.claude');await fs.mkdir(account);
  const assetPath=path.join(root,'DevRyan-Claude-fixture');
  // A native fixture preserves exact executable attestation; no interpreter
  // may substitute its own OS identity for the reviewed command.
  const sourcePath=path.join(root,'claude-fixture.c');
  await fs.writeFile(sourcePath,`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
int main(int argc,char **argv){
 const char *token=getenv("CLAUDE_CODE_OAUTH_TOKEN"),*model=getenv("ANTHROPIC_DEFAULT_OPUS_MODEL"),*state=getenv("CLAUDE_CONFIG_DIR");
 if(!token||strcmp(token,"owned-offline-fixture"))return 10;
 if(!model||strcmp(model,"claude-opus-5-5"))return 11;
 if(argc<3||!state)return 15;
 char name[PATH_MAX];FILE *file;
 snprintf(name,sizeof(name),"%s/project-write",argv[1]);file=fopen(name,"w");if(file){fclose(file);return 12;}
 snprintf(name,sizeof(name),"%s/credential",argv[2]);file=fopen(name,"r");if(file){fclose(file);return 13;}
 snprintf(name,sizeof(name),"%s/owned-write",state);file=fopen(name,"w");if(!file)return 14;fclose(file);
 if(argc>3&&!strcmp(argv[3],"wait")){puts("ready");fflush(stdout);sleep(30);}
 char bytes[4096];ssize_t count;while((count=read(0,bytes,sizeof(bytes)))>0){if(write(1,bytes,(size_t)count)!=count)return 16;}
 return 0;
}`);
  const compiled=spawnSync('/usr/bin/clang',['-O0',sourcePath,'-o',assetPath],{encoding:'utf8',timeout:10000});
  expect(compiled.stderr).toBe('');expect(compiled.status).toBe(0);
  await fs.writeFile(path.join(denied,'credential'),'synthetic-private-fixture');
  const boot:NativeProviderBoot={protocol:1,type:'provider-boot',provider:'anthropic',instanceID:randomUUID(),buildId:'a'.repeat(64),requestAuthorization:'b'.repeat(64),globals,
   profiles:[{id:'selected',type:'claude-max',claudeConfigDir:account,keychainService:'Claude Code-credentials'}],defaultProfile:'selected',
   assets:{claude:{path:assetPath,sha256:createHash('sha256').update(await fs.readFile(assetPath)).digest('hex')},libsql:{path:assetPath,sha256:'c'.repeat(64)}},transport:{launcher,storage,directories:[directory]}};
  const scope={attemptID:'d'.repeat(64),sessionID:'ses_fixture',directory},entry=path.join(root,'entry.ts');
  await fs.writeFile(entry,`import {createClaudeTransportChannel} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-claude-transport-channel.ts'))};\nimport {createInterface} from 'node:readline';\nconst channel=createClaudeTransportChannel(frame=>process.stdout.write(JSON.stringify(frame)+'\\n'));\nconst lines=createInterface({input:process.stdin});lines.on('line',line=>channel.accept(JSON.parse(line)));\nconst child=channel.spawn(${JSON.stringify({...scope,profileID:'selected',args:[directory,denied,...cancel?['wait']:[]],modelPins:{opus:'claude-opus-5-5'},toolSearch:false})});\nchild.on('error',()=>{});let output='';child.stdout.on('data',bytes=>{output+=bytes;${cancel?"if(output.includes('ready'))child.kill();":''}});child.stdin.end('fixture-input\\n');child.once('close',()=>{process.stdout.write(JSON.stringify({type:'fixture-result',code:child.exitCode,output})+'\\n');lines.close();process.stdin.destroy();});\n`);
  const supervised=await prepareSupervisedController({...boot,databasePath:path.join(databaseDirectory,'opencode.db')},{launcher,deniedReadDirectories:[denied]});
  const worker=spawn(launcher,[...supervised.arguments,process.execPath,entry],{cwd:databaseDirectory,env:{PATH:'/usr/bin:/bin',DEVRYAN_EXECUTION_WORKER:'1',DYLD_INSERT_LIBRARIES:`${launcher}-spawn.dylib`},stdio:['pipe','pipe','pipe']});child=worker;
  const ended=new Promise<number|null>((resolve,reject)=>{worker.once('error',reject);worker.once('close',resolve);});
  const replies:unknown[]=[],errors:unknown[]=[],work:Promise<void>[]=[],results:{type:'fixture-result';code:number;output:string}[]=[];
  broker=createNativeClaudeTransportHost({boot,environment:{PATH:'/usr/bin:/bin',HOME:globals.home},deniedReadDirectories:[denied],
   resolveCredential:async request=>({profileID:request.profileID,accessToken:'owned-offline-fixture',expiresAt:Date.now()+3600000,fingerprint:'e'.repeat(64)}),
   send:async frame=>{replies.push(frame);await new Promise<void>((resolve,reject)=>worker.stdin.write(JSON.stringify(frame)+'\n',error=>error?reject(error):resolve()));}});
  broker.authorize(scope);const host=broker;
  const lines=createInterface({input:worker.stdout});lines.on('line',line=>{const frame=JSON.parse(line);if(frame.type==='fixture-result'){results.push(frame);return;}work.push(host.accept(frame).catch(error=>{errors.push(error);}));});
  const timeout=setTimeout(()=>worker.kill('SIGTERM'),5000);
  try{expect(await ended).toBe(0);}finally{clearTimeout(timeout);lines.close();}
  await Promise.all(work);expect(errors).toEqual([]);expect(results).toEqual([{type:'fixture-result',code:cancel?137:0,output:cancel?'ready\n':'fixture-input\n'}]);
  expect(replies).toContainEqual(expect.objectContaining({action:'settled',receipt:{terminated:true,confined:true,cancelled:cancel,exitCode:cancel?137:0}}));
  expect(JSON.parse(await fs.readFile(supervised.receiptPath,'utf8'))).toMatchObject({terminated:true,confined:true,exitCode:0});
  await expect(fs.access(path.join(directory,'project-write'))).rejects.toMatchObject({code:'ENOENT'});
  const state=path.join(storage,'state',createHash('sha256').update(JSON.stringify([account,directory])).digest('hex'));
  await expect(fs.stat(path.join(state,'owned-write'))).resolves.toMatchObject({});
  await broker.release(scope);await broker.close();broker=undefined;
 }finally{if(child&&child.exitCode===null)child.kill('SIGTERM');await broker?.close();await fs.rm(root,{recursive:true,force:true});}
},10000);
