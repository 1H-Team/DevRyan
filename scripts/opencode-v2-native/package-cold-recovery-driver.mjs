import assert from 'node:assert/strict';
import {Console} from 'node:console';
import path from 'node:path';
import {readManagedOpenCodeRegistry} from '../../packages/web/server/lib/opencode/managed-process-registry.js';

globalThis.console=new Console({stdout:process.stderr,stderr:process.stderr});
let bytes='';for await(const chunk of process.stdin){bytes+=chunk;assert.ok(Buffer.byteLength(bytes)<=4096);}
const input=JSON.parse(bytes);
const {selectedRuntimeBundle:binding}=await import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js');
assert.equal(binding?.admission,'held');assert.equal(binding.selection.revision,input.expectedRevision);assert.equal(binding.descriptor.bundleID,input.candidateBundleID);
const {startWebUiServer}=await import('../../packages/web/server/index.js');
let server,result;
try{
 server=await startWebUiServer({host:'127.0.0.1',port:0,attachSignals:false});
 assert.equal(server.isReady(),false);assert.equal(server.getOpenCodePort(),null);assert.equal(server.getManagedOrchestrationDiagnostics(),null);
 assert.deepEqual(server.getBrowserLeaseDiagnostics(),{activeLeases:0});assert.equal(await server.issueLocalOwnerSession(),null);
 const quit=await server.getQuitRiskStatus();assert.equal(quit.tunnel.active,false);assert.equal(quit.scheduledTasksVerified,true);
 assert.equal(quit.scheduledTasks.hasEnabledScheduledTasks,false);assert.equal(quit.scheduledTasks.hasPendingScheduledTasks,false);assert.equal(quit.scheduledTasks.hasRunningScheduledTasks,false);
 const registry=path.join(binding.descriptor.launch.global.state,'managed-opencode-processes.json');assert.deepEqual(readManagedOpenCodeRegistry({registryPath:registry}),[]);
 const origin=`http://127.0.0.1:${server.getPort()}`;
 const page=await fetch(origin,{signal:AbortSignal.timeout(10000)});assert.equal(page.status,200);assert.match(await page.text(),/Runtime recovery is required/);
 const status=await fetch(origin+'/api/runtime/bundle',{signal:AbortSignal.timeout(10000)});assert.equal(status.status,200);const state=await status.json();
 assert.equal(state.state,'held');assert.equal(state.revision,input.expectedRevision);assert.equal(state.resumeAvailable,true);assert.equal(state.reconciliationRequired,true);
 const requests=[['GET','/health'],['GET','/api/session'],['GET','/api/provider'],['POST','/api/session'],['POST','/api/runtime/bundle/resume'],['POST','/api/runtime/bundle/upgrade'],['POST','/api/provider/anthropic/enrollment']];
 for(const [method,route] of requests){const response=await fetch(origin+route,{method,headers:{'content-type':'application/json','x-devryan-csrf':'1'},...(method==='POST'?{body:JSON.stringify({expectedRevision:input.expectedRevision})}:{}),signal:AbortSignal.timeout(10000)});assert.equal(response.status,503,route);await response.body?.cancel();}
 assert.deepEqual(readManagedOpenCodeRegistry({registryPath:registry}),[]);
 result={status:'passed',state:'held',revision:state.revision,bundleID:state.bundleID,controllerStarts:0,featureOwners:false,httpMutationsRefused:true,refusedRoutes:requests.map(([,route])=>route)};
}catch(error){result={status:'failed',error:{code:error.code??null,message:error.message}};process.exitCode=1;}
finally{if(server)await server.stop({exitProcess:false});}
process.stdout.write(JSON.stringify(result)+'\n');
