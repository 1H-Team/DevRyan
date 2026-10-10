import {expect,it,vi} from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import express from 'express';
import request from '../../test-supertest.js';
import { createHmrStateRuntime } from './hmr-state-runtime.js';
import { registerServerStatusRoutes } from './core-routes.js';
import {createOpenCodeLifecycleRuntime} from './lifecycle.js';
function fixture(overrides={}){
 const events=[],state=overrides.state??{openCodeWorkingDirectory:process.cwd(),isShuttingDown:false},children=[];
 const native={isReady:()=>Boolean(children.at(-1)&&!children.at(-1).exited),start:vi.fn(async({beforeConfiguration}={})=>{await (overrides.getRuntimeBundle?.()??bundle).verify();await beforeConfiguration?.();const child={port:43100,url:'http://localhost:43100',hasExited:()=>child.exited,close:async()=>{events.push('exit');child.exited=true;},killForRecovery:async()=>{events.push('settle');child.exited=true;}};children.push(child);return child;})};
 const bundle={version:'2.0.26',descriptor:{generation:2,projectMap:[{targetDirectory:process.cwd()}]},verify:async()=>events.push('verify')};
 const runtime=createOpenCodeLifecycleRuntime({state,getNativeRuntime:()=>native,getRuntimeBundle:()=>bundle,
  buildOpenCodeUrl:()=> 'http://localhost:43100',resolveSlimConfiguration:()=>({enabled:false}),
  syncPackagedAgents:async()=>{events.push('agents');return {changed:false};},syncRuntimeAgentOverlays:async()=>({changed:false}),
  probeOpenCodeReadiness:async input=>{expect(input.generation).toBe(2);events.push('probe');return {ready:true,generation:2,version:bundle.version};},
  pauseManagedBrowserLeases:async()=>{events.push('pause');return 'owned';},resumeManagedBrowserLeases:async handle=>{expect(handle).toBe('owned');events.push('resume');},...overrides});
 return {runtime,state,native,bundle,events,children};
}
it('starts only a verified native owner and waits for its catalog',async()=>{const f=fixture();await f.runtime.bootstrapOpenCodeAtStartup();expect(f.events).toEqual(['verify','agents','probe']);expect(f.state).toMatchObject({openCodeGeneration:2,openCodeVersion:'2.0.26',isOpenCodeReady:true,isExternalOpenCode:false});expect(f.state.openCodeProcess).toBe(f.children[0]);});
it('publishes startup attempts and terminal boot failure before any controller binds', async () => {
 const f=fixture();
 expect(f.state.openCodeStartup).toEqual({state:'idle',attempt:0,code:null});
 let rejectBoot;
 f.native.start.mockImplementationOnce(()=>new Promise((_,reject)=>{rejectBoot=reject;}));
 const boot=f.runtime.bootstrapOpenCodeAtStartup();
 await vi.waitFor(()=>expect(rejectBoot).toBeTypeOf('function'));
 expect(f.state.openCodeStartup).toEqual({state:'starting',attempt:1,code:null});
 const code='native_catalog_read_failed_model_http_500_cause_unavailable';
 rejectBoot(Object.assign(new Error(code),{code}));
 await expect(boot).rejects.toMatchObject({code});
 expect(f.state.openCodeStartup).toEqual({state:'failed',attempt:1,code});
 expect(f.state.openCodeProcess).toBeUndefined();
 await f.runtime.restartOpenCode();
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
 expect(f.state.lastOpenCodeError).toBeNull();
});
it('does not publish raw failure details in startup status and clears failure before retry work', async () => {
 const f=fixture();
 f.bundle.verify=async()=>{throw new Error('secret fixture /private/config');};
 await expect(f.runtime.startOpenCode()).rejects.toThrow('secret fixture');
 expect(f.state.openCodeStartup).toEqual({state:'failed',attempt:1,code:'opencode_startup_failed'});
 let releaseVerification;
 f.bundle.verify=()=>new Promise(resolve=>{releaseVerification=resolve;});
 const retry=f.runtime.startOpenCode();
 expect(f.state.openCodeStartup).toEqual({state:'starting',attempt:2,code:null});
 expect(f.state.lastOpenCodeError).toBeNull();
 releaseVerification();await retry;
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
});
it('a superseded startup failure cannot replace the current attempt status', async () => {
 const f=fixture();let rejectFirst;
 f.bundle.verify=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectFirst=reject;})).mockResolvedValue(undefined);
 const first=f.runtime.startOpenCode();
 await f.runtime.startOpenCode();
 rejectFirst(Object.assign(new Error('late failure'),{code:'native_old_failure'}));
 await expect(first).rejects.toThrow('late failure');
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
 expect(f.state.isOpenCodeReady).toBe(true);
});
it('a superseded successful readiness probe cannot clear a newer terminal startup failure', async () => {
 let releaseProbe;
 const probe=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{releaseProbe=resolve;}));
 const f=fixture({probeOpenCodeReadiness:probe});
 const first=f.runtime.startOpenCode();
 await vi.waitFor(()=>expect(releaseProbe).toBeTypeOf('function'));
 f.bundle.verify=async()=>{throw Object.assign(new Error('replacement failed'),{code:'native_replacement_failed'});};
 await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'native_replacement_failed'});
 const current={...f.state};
 releaseProbe({ready:true,generation:2,version:'old-probe-version'});
 await expect(first).rejects.toMatchObject({code:'opencode_startup_superseded'});
 expect(f.state.openCodeStartup).toEqual({state:'failed',attempt:2,code:'native_replacement_failed'});
 expect(f.state.isOpenCodeReady).toBe(false);
 expect(f.state.lastOpenCodeError).toBe('replacement failed');
 expect(f.state.openCodeVersion).toBe(current.openCodeVersion);
});
it('a superseded failing readiness probe cannot overwrite the new ready owner', async () => {
 let rejectProbe;
 const probe=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectProbe=reject;}))
  .mockResolvedValue({ready:true,generation:2,version:'2.0.26'});
 const f=fixture({probeOpenCodeReadiness:probe});
 const first=f.runtime.startOpenCode();
 await vi.waitFor(()=>expect(rejectProbe).toBeTypeOf('function'));
 await f.runtime.startOpenCode();
 const currentOwner=f.state.openCodeProcess;
 rejectProbe(new Error('old probe timeout'));
 await expect(first).rejects.toMatchObject({code:'opencode_startup_superseded'});
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
 expect(f.state.isOpenCodeReady).toBe(true);
 expect(f.state.lastOpenCodeError).toBeNull();
 expect(f.state.openCodeProcess).toBe(currentOwner);
});
it('missing or unsupported verified lifecycle version refuses before the controller starts',async()=>{for(const version of [undefined,'1.18.33','3.0.0','2.0.26-dev']){const f=fixture();f.bundle.version=version;await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'native_runtime_bundle_required'});expect(f.native.start).not.toHaveBeenCalled();}});
it('any other 2.x release requires the pinned upgrade before the controller starts',async()=>{for(const version of ['2.0.20','2.0.25','2.0.27']){const f=fixture();f.bundle.version=version;await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'bundle_upgrade_required'});expect(f.native.start).not.toHaveBeenCalled();}});
it('inspects and restores prompts through their existing owner without applying runtime overlays', async () => {
 const prompts=[{name:'builder',state:'modified',currentHash:'a'.repeat(64),packagedHash:'b'.repeat(64)}];
 const sync=vi.fn(async()=>({prompts,changed:false})),overlays=vi.fn();
 const f=fixture({syncPackagedAgents:sync,syncRuntimeAgentOverlays:overlays});
 expect(await f.runtime.getPackagedAgentPrompts()).toEqual({prompts});
 expect(sync).toHaveBeenCalledWith(expect.objectContaining({dryRun:true}));
 await expect(f.runtime.restorePackagedAgentPrompt({name:'../builder',expectedHash:'a'.repeat(64)})).rejects.toMatchObject({status:400});
 await f.runtime.restorePackagedAgentPrompt({name:'builder',expectedHash:'a'.repeat(64)});
 expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({restoreOnly:true,restoreAgentNames:['builder'],expectedAgentHashes:{builder:'a'.repeat(64)}}));
 expect(overlays).not.toHaveBeenCalled();expect(f.native.start).not.toHaveBeenCalled();
});
it('missing/legacy bundle or external flags fail before any owner starts',async()=>{for(const overrides of [{getNativeRuntime:()=>null},{getRuntimeBundle:()=>({descriptor:{generation:1}})},{env:{ENV_SKIP_OPENCODE_START:true}},{env:{ENV_CONFIGURED_OPENCODE_HOST:{origin:'http://localhost:1'}}}]){const f=fixture(overrides);await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'native_runtime_bundle_required'});expect(f.native.start).not.toHaveBeenCalled();}});
it('artifact failure never falls back to a standalone executable or marks ready',async()=>{const f=fixture({getRuntimeBundle:()=>({version:'2.0.26',descriptor:{generation:2,projectMap:[{targetDirectory:process.cwd()}]},verify:async()=>{throw Object.assign(Error('invalid'),{code:'native_runtime_artifacts_unverified'});}})});await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});expect(f.children).toHaveLength(0);expect(f.events).not.toContain('agents');expect(f.state.isOpenCodeReady).toBe(false);});
it('replacement drains the exact child and browser lease before native restart',async()=>{const f=fixture();await f.runtime.startOpenCode();f.events.length=0;await Promise.all([f.runtime.restartOpenCode(),f.runtime.restartOpenCode()]);expect(f.events).toEqual(['pause','exit','verify','agents','probe','resume']);expect(f.native.start).toHaveBeenCalledTimes(2);expect(f.state.isRestartingOpenCode).toBe(false);});
it('a synchronous pause failure clears restart ownership and the next health check retries',async()=>{
 const pause=vi.fn().mockImplementationOnce(()=>{throw new Error('pause failed');}).mockResolvedValue('owned');
 const resume=vi.fn(async()=>{}),f=fixture({pauseManagedBrowserLeases:pause,resumeManagedBrowserLeases:resume});
 await f.runtime.startOpenCode();
 await expect(f.runtime.restartOpenCode()).rejects.toThrow('pause failed');
 expect(f.state).toMatchObject({isRestartingOpenCode:false,currentRestartPromise:null,isOpenCodeReady:false});
 expect(f.children[0].exited).not.toBe(true);expect(resume).not.toHaveBeenCalled();
 await f.runtime.triggerHealthCheck();
 expect(pause).toHaveBeenCalledTimes(2);expect(resume).toHaveBeenCalledWith('owned');expect(f.state.isOpenCodeReady).toBe(true);
});
it('a failed resume retains its browser hold and releases restart ownership for recovery',async()=>{
 const handle={},pause=vi.fn(async()=>handle),resume=vi.fn().mockRejectedValueOnce(new Error('resume failed')).mockResolvedValue(true);
 const f=fixture({pauseManagedBrowserLeases:pause,resumeManagedBrowserLeases:resume});await f.runtime.startOpenCode();
 await expect(f.runtime.restartOpenCode()).rejects.toThrow('resume failed');
 expect(f.state).toMatchObject({isRestartingOpenCode:false,currentRestartPromise:null,isOpenCodeReady:false});
 await f.runtime.triggerHealthCheck();
 expect(pause).toHaveBeenCalledTimes(1);expect(resume.mock.calls).toEqual([[handle],[handle]]);
 expect(f.state).toMatchObject({isRestartingOpenCode:false,currentRestartPromise:null,isOpenCodeReady:true});
});
it('a failed replacement keeps browser admission paused until a successful retry',async()=>{
 const pause=vi.fn(async()=> 'owned'),resume=vi.fn(async()=>{}),f=fixture({pauseManagedBrowserLeases:pause,resumeManagedBrowserLeases:resume});
 await f.runtime.startOpenCode();f.native.start.mockRejectedValueOnce(new Error('launch failed'));
 await expect(f.runtime.restartOpenCode()).rejects.toThrow('launch failed');
 expect(resume).not.toHaveBeenCalled();expect(f.state.currentRestartPromise).toBeNull();
 await f.runtime.restartOpenCode();expect(pause).toHaveBeenCalledTimes(1);expect(resume).toHaveBeenCalledWith('owned');
});
it('publishes the accepted launch settings only after readiness, independent of later disk changes',async()=>{
 let configured={lsp:false};let releaseReady;let readingReady;
 const readyStarted=new Promise(resolve=>{readingReady=resolve;});
 const readiness=new Promise(resolve=>{releaseReady=resolve;});
 const f=fixture({readAgentRuntimeSettings:()=>configured,probeOpenCodeReadiness:async()=>{readingReady();await readiness;return {ready:true,generation:2,version:f.bundle.version};}});
 f.native.getConfigurationSnapshot=()=>({locations:[{directory:process.cwd(),configuration:{lsp:false}}]});
 const start=f.runtime.startOpenCode();await readyStarted;
 configured={lsp:true};expect(f.runtime.getAgentRuntimeApplicationState().appliedLsp).toBeNull();
 releaseReady();await start;expect(f.runtime.getAgentRuntimeApplicationState().appliedLsp).toBe(false);
});
it('failed launch readiness does not publish unaccepted runtime settings',async()=>{
 const state={openCodeWorkingDirectory:process.cwd(),appliedAgentRuntimeSettings:{lsp:false}};
 const f=fixture({state,readAgentRuntimeSettings:()=>({lsp:true}),probeOpenCodeReadiness:async()=>({ready:false,reason:'generation_invalid'})});
 await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'opencode_runtime_not_ready'});
 expect(f.runtime.getAgentRuntimeApplicationState().appliedLsp).toBe(false);
});
it('readiness failure remains closed and config changes use the same native restart',async()=>{let ready=false;const f=fixture({probeOpenCodeReadiness:async()=>({ready,generation:2,reason:'generation_invalid',version:'2.0.20'})});await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'opencode_runtime_not_ready'});expect(f.state.isOpenCodeReady).toBe(false);ready=true;expect(await f.runtime.applyOpenCodeConfigChanges({scopes:['agents'],changes:[{metadata:{agentName:'builder'}}]})).toEqual({runtimeApplied:true,requiresReload:false});expect(f.native.start).toHaveBeenCalledTimes(2);});
it('dead native children restart while live busy children are preserved',async()=>{let healthy=true;const f=fixture({getActiveSessionCount:()=>1,probeOpenCodeReadiness:async()=>({ready:healthy,generation:2,reason:'unreachable',version:'2.0.20'})});await f.runtime.startOpenCode();healthy=false;await f.runtime.triggerHealthCheck();expect(f.native.start).toHaveBeenCalledTimes(1);f.children[0].exited=true;healthy=true;await f.runtime.triggerHealthCheck();expect(f.events).toContain('settle');expect(f.native.start).toHaveBeenCalledTimes(2);});

it('inherited process identity cannot mark a new native owner ready or start another child',async()=>{const f=fixture({syncFromHmrState:()=>{f.state.openCodeProcess={hasExited:()=>false};f.state.openCodeGeneration=1;f.state.openCodeVersion='1.18.33';f.state.isOpenCodeReady=true;}});await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'native_runtime_owner_mismatch'});expect(f.native.start).not.toHaveBeenCalled();expect(f.state.isOpenCodeReady).toBe(false);expect(f.events).toEqual([]);});


it('forwards the native lifecycle version into original application health and HMR state', async () => {
  const source = readFileSync(new URL('../../application.js', import.meta.url), 'utf8');
  const descriptors = source.slice(
    source.indexOf('const openCodeLifecycleState = {};'),
    source.indexOf('const openAiOAuthCoordinator ='),
  );
  const sync = source.slice(
    source.indexOf('const syncToHmrState = () => {'),
    source.indexOf('// Sync helper - call to restore state from HMR'),
  );
  const health = source.slice(
    source.indexOf('    getHealthSnapshot: () => {'),
    source.indexOf('    verboseRequestLogs:'),
  ).trim().replace(/^getHealthSnapshot: /, 'const getHealthSnapshot = ').replace(/,$/, ';');
  // Execute only the original composition closures, not application initialization.
  // The native factory below has no process, provider or installed-data access.
  const bindings = Object.fromEntries(
    [...descriptors.matchAll(/get: \(\) => (\w+)/g)].map((match) => [match[1], null]),
  );
  const hmrState = {};
  const composition = runInNewContext(`${descriptors}\n${sync}\n${health}\n({
    state: openCodeLifecycleState, syncToHmrState, getHealthSnapshot,
  })`, {
    ...bindings,
    hmrState,
    hmrStateRuntime: createHmrStateRuntime({}),
    invalidateOpenCodeRuntime: () => {},
    openCodeWorkingDirectory: process.cwd(),
    openCodeVersion: null,
    openCodePaths: {},
    openCodeEpoch: 0,
    signalsAttached: false,
    openCodeAuthPassword: null,
    openCodeAuthSource: null,
    runtimeInstanceId: 'composition-fixture',
    isOpenCodeConnectionSecure: () => true,
    executionReadiness: { state: 'ready' },
    nativeBundle: { artifacts: { controller: 'fixture-controller' } },
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    ENV_DESKTOP_NOTIFY: false,
    PLAN_MODE_EXPERIMENT_ENABLED: false,
    multiUserRuntime: { enabled: false },
  });
  const f = fixture({ state: composition.state, syncToHmrState: composition.syncToHmrState });
  expect(composition.getHealthSnapshot()).toMatchObject({ openCodeVersion: null, openCodeRunning: false,
    openCodeStartup: { state: 'idle', attempt: 0, code: null } });
  await f.runtime.bootstrapOpenCodeAtStartup();
  expect(hmrState).toMatchObject({ openCodeVersion: '2.0.26', openCodePort: 43100 });
  const app = express();
  registerServerStatusRoutes(app, {
    express,
    process,
    gracefulShutdown: vi.fn(),
    getHealthSnapshot: composition.getHealthSnapshot,
    getNativeRuntimeOwner: () => f.native,
    runtimeInstanceId: 'composition-fixture',
  });
  for (const route of ['/health', '/api/health']) {
    const response = await request(app).get(route);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      openCodeVersion: '2.0.26', openCodePort: 43100,
      openCodeGeneration: 2, openCodeRunning: true, isOpenCodeReady: true,
      openCodeStartup: { state: 'ready', attempt: 1, code: null },
    });
  }
  composition.state.isOpenCodeReady = false;
  expect(composition.getHealthSnapshot().openCodeRunning).toBe(false);
  composition.state.isOpenCodeReady = true;
  composition.state.isRestartingOpenCode = true;
  expect(composition.getHealthSnapshot().openCodeRunning).toBe(false);
  composition.state.openCodePort = null;
  expect(composition.getHealthSnapshot()).toMatchObject({ openCodeVersion: null, openCodeRunning: false });
});

it('retained runtime reports its verified bundle version through launch and inherited ownership',async()=>{vi.stubEnv('DEVRYAN_QA_OPENCODE_VERSION','2.0.20');try{const f=fixture();f.bundle.version='2.0.20';await f.runtime.bootstrapOpenCodeAtStartup();expect(f.state.openCodeVersion).toBe('2.0.20');await f.runtime.bootstrapOpenCodeAtStartup();expect(f.native.start).toHaveBeenCalledTimes(1);}finally{vi.unstubAllEnvs();}});
it('a supported runtime below the version pin refuses before launch and names the recorded startup upgrade failure',async()=>{
 const f=fixture();f.bundle.version='2.0.20';
 await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'bundle_upgrade_required',message:expect.stringContaining('OpenCode 2.0.20 must be upgraded to 2.0.26')});
 expect(f.native.start).not.toHaveBeenCalled();expect(f.events).toEqual([]);expect(f.state.lastOpenCodeError).toMatch(/Restart DevRyan to retry the upgrade\.$/);
 const {recordStartupBundleUpgradeFailure}=await import('./runtime-host/bundle-startup-upgrade-status.js');recordStartupBundleUpgradeFailure('bundle_upgrade_owner_active');
 try{await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({message:expect.stringContaining('the startup upgrade did not complete (bundle_upgrade_owner_active)')});}
 finally{recordStartupBundleUpgradeFailure(null);}
 expect(f.native.start).not.toHaveBeenCalled();
});
