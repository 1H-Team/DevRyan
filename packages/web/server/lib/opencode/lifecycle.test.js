import {expect,it,vi} from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import express from 'express';
import request from '../../test-supertest.js';
import { createHmrStateRuntime } from './hmr-state-runtime.js';
import { registerServerStatusRoutes } from './core-routes.js';
import { registerOpenCodeRoutes } from './routes.js';
import {createOpenCodeLifecycleRuntime} from './lifecycle.js';
import {createMemorySessionTitleOutbox} from './session-title-outbox.js';
import {createStandardSessionTitleRuntime} from './standard-session-title-runtime.js';
function fixture(overrides={}){
 const events=[],state=overrides.state??{openCodeWorkingDirectory:process.cwd(),isShuttingDown:false},children=[];
 const native={isReady:()=>Boolean(children.at(-1)&&!children.at(-1).exited),start:vi.fn(async({beforeConfiguration}={})=>{await (overrides.getRuntimeBundle?.()??bundle).verify();await beforeConfiguration?.();const child={port:43100,url:'http://localhost:43100',hasExited:()=>child.exited,close:async()=>{events.push('exit');child.exited=true;},killForRecovery:async()=>{events.push('settle');child.exited=true;}};children.push(child);return child;})};
 const bundle={version:'2.1.4',descriptor:{generation:2,projectMap:[{targetDirectory:process.cwd()}]},verify:async()=>events.push('verify')};
 const runtime=createOpenCodeLifecycleRuntime({state,getNativeRuntime:()=>native,getRuntimeBundle:()=>bundle,
  // Never migrate or read the real user OpenCode config directory from a test.
  buildOpenCodeUrl:()=> 'http://localhost:43100',resolveSlimConfiguration:()=>({}),migrateAgentsConfiguration:()=>({migrated:false,reason:'absent'}),
  syncPackagedAgents:async()=>{events.push('agents');return {changed:false};},syncRuntimeAgentOverlays:async()=>({changed:false}),
  probeOpenCodeReadiness:async input=>{expect(input.generation).toBe(2);events.push('probe');return {ready:true,generation:2,version:bundle.version};},
  pauseManagedBrowserLeases:async()=>{events.push('pause');return 'owned';},resumeManagedBrowserLeases:async handle=>{expect(handle).toBe('owned');events.push('resume');},...overrides});
 return {runtime,state,native,bundle,events,children};
}
it('migrates the legacy agent config before resolving it on every configured start',async()=>{const order=[];const f=fixture({migrateAgentsConfiguration:()=>{order.push('migrate');return {migrated:false,reason:'failed',code:'INVALID_JSONC'};},resolveSlimConfiguration:()=>{order.push('resolve');return {};}});await f.runtime.bootstrapOpenCodeAtStartup();expect(order).toEqual(['migrate','resolve']);expect(f.state.isOpenCodeReady).toBe(true);});
it('starts only a verified native owner and waits for its catalog',async()=>{const f=fixture();await f.runtime.bootstrapOpenCodeAtStartup();expect(f.events).toEqual(['verify','agents','probe']);expect(f.state).toMatchObject({openCodeGeneration:2,openCodeVersion:'2.1.4',isOpenCodeReady:true,isExternalOpenCode:false});expect(f.state.openCodeProcess).toBe(f.children[0]);});
it('startup deferral exists only inside the original readiness deadline, even if a probe ignores its timeout',async()=>{
 vi.useFakeTimers();let entered,release;
 const began=new Promise(resolve=>{entered=resolve;});
 const f=fixture({probeOpenCodeReadiness:()=>{entered();return new Promise(resolve=>{release=resolve;});}});
 const boot=f.runtime.startOpenCode();const failure=boot.catch(error=>error);
 try{
  expect(f.runtime.isStartupReadinessPending()).toBe(true);await began;
  expect(f.runtime.isStartupReadinessPending()).toBe(true);
  await vi.advanceTimersByTimeAsync(19_999);expect(f.runtime.isStartupReadinessPending()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);expect(f.runtime.isStartupReadinessPending()).toBe(false);
  release({ready:false,reason:'unreachable'});expect(await failure).toMatchObject({code:'opencode_runtime_not_ready'});
  expect(f.state.openCodeStartup.state).toBe('failed');expect(f.runtime.isStartupReadinessPending()).toBe(false);
 }finally{release?.({ready:false,reason:'unreachable'});await failure;vi.useRealTimers();}
});
it('pre-bind startup defers restored titles only within the original bounded startup window',async()=>{
 vi.useFakeTimers();
 const f=fixture();let reject;f.native.start.mockImplementationOnce(()=>new Promise((_resolve,rejectBoot)=>{reject=rejectBoot;}));
 const boot=f.runtime.startOpenCode();const failure=boot.catch(error=>error);
 try{
  expect(f.state.openCodeStartup.state).toBe('starting');expect(f.runtime.isStartupReadinessPending()).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000);expect(f.runtime.isStartupReadinessPending()).toBe(false);
 }finally{
  reject(Object.assign(Error('native_fixture_startup_failed'),{code:'native_fixture_startup_failed'}));await failure;vi.useRealTimers();
 }
});
it('a repeated readiness check cannot reset the original startup deadline',async()=>{
 vi.useFakeTimers();const releases=[],entries=[];let wake;
 const f=fixture({probeOpenCodeReadiness:()=>{entries.push(true);wake?.();return new Promise(resolve=>releases.push(resolve));}});
 const boot=f.runtime.startOpenCode(),failure=boot.catch(error=>error);let repeated;
 try{
  await new Promise(resolve=>{if(entries.length)resolve();else wake=resolve;});
  await vi.advanceTimersByTimeAsync(10_000);
  repeated=f.runtime.waitForOpenCodeReady().catch(error=>error);
  await new Promise(resolve=>{if(entries.length===2)resolve();else wake=resolve;});
  expect(f.runtime.isStartupReadinessPending()).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);expect(f.runtime.isStartupReadinessPending()).toBe(false);
 }finally{
  for(const release of releases)release({ready:true,generation:2});await Promise.all([failure,repeated]);vi.useRealTimers();
 }
});
it('restored title jobs survive native pre-bind startup and persist once after readiness',async()=>{
 vi.useFakeTimers();
 const f=fixture();let releaseStart;
 const start=f.native.start.getMockImplementation();
 f.native.start.mockImplementationOnce(async input=>{await new Promise(resolve=>{releaseStart=resolve;});return start(input);});
 const session={id:'ses_restored',title:'Untitled Session'};
 const outbox=createMemorySessionTitleOutbox({initialJobs:[{key:'a'.repeat(64),sessionID:session.id,directory:process.cwd(),sourceHash:'b'.repeat(64),
  sourceMessageID:'msg_source',candidateTitle:'Restored Model Session Title',source:'session_model',state:'pending_idle',attemptCount:0,nextAttemptAt:0,createdAt:Date.now()}]});
 const rename=vi.fn(async({title})=>{session.title=title;});
 const titles=createStandardSessionTitleRuntime({outbox,watchdogEnabled:true,renameGeneratedTitle:rename,
  isStartupReadinessPending:f.runtime.isStartupReadinessPending,logger:{warn:vi.fn()},
  openCodeClient:{generation:()=>2,sessions:{get:async()=>{
   if(!f.state.isOpenCodeReady)throw Object.assign(Error('not ready'),{code:'native_runtime_not_ready'});
   return {...session};
  },status:async()=>({[session.id]:{type:'idle'}})}}});
 const boot=f.runtime.startOpenCode();
 try{
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await outbox.list())[0]).toMatchObject({state:'pending_idle',attemptCount:0});expect(rename).not.toHaveBeenCalled();
  releaseStart();await boot;await vi.advanceTimersByTimeAsync(5_000);
  expect(rename).toHaveBeenCalledOnce();expect(await outbox.list()).toEqual([]);
  await vi.advanceTimersByTimeAsync(30_000);expect(rename).toHaveBeenCalledOnce();
 }finally{releaseStart();await boot;await titles.dispose();vi.useRealTimers();}
});
it('concurrent boot and start calls share the readiness window and native launch',async()=>{
 let releaseProbe;
 const f=fixture({probeOpenCodeReadiness:()=>new Promise(resolve=>{releaseProbe=resolve;})});
 const first=f.runtime.bootstrapOpenCodeAtStartup();
 await vi.waitFor(()=>expect(releaseProbe).toBeTypeOf('function'));
 const second=f.runtime.startOpenCode(),third=f.runtime.bootstrapOpenCodeAtStartup();
 expect(second).toBe(first);expect(third).toBe(first);
 expect(f.runtime.isStartupReadinessPending()).toBe(true);
 expect(f.state.openCodeStartup.attempt).toBe(1);
 releaseProbe({ready:true,generation:2});await Promise.all([first,second,third]);
 expect(f.native.start).toHaveBeenCalledOnce();expect(f.runtime.isStartupReadinessPending()).toBe(false);
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:1,code:null});
});
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
 await vi.waitFor(()=>expect(releaseVerification).toBeTypeOf('function'));
 releaseVerification();await retry;
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
});
it('a superseded startup failure cannot replace the current attempt status', async () => {
 const f=fixture();let rejectFirst;
 f.bundle.verify=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectFirst=reject;})).mockResolvedValue(undefined);
 const first=f.runtime.startOpenCode();
 await vi.waitFor(()=>expect(rejectFirst).toBeTypeOf('function'));
 f.state.openCodeStartup={state:'ready',attempt:2,code:null};f.state.isOpenCodeReady=true;
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
 f.state.openCodeStartup={state:'failed',attempt:2,code:'native_replacement_failed'};
 f.state.isOpenCodeReady=false;f.state.lastOpenCodeError='replacement failed';
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
  .mockResolvedValue({ready:true,generation:2,version:'2.1.4'});
 const f=fixture({probeOpenCodeReadiness:probe});
 const first=f.runtime.startOpenCode();
 await vi.waitFor(()=>expect(rejectProbe).toBeTypeOf('function'));
 f.state.openCodeStartup={state:'ready',attempt:2,code:null};f.state.isOpenCodeReady=true;
 const currentOwner=f.state.openCodeProcess;
 rejectProbe(new Error('old probe timeout'));
 await expect(first).rejects.toMatchObject({code:'opencode_startup_superseded'});
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
 expect(f.state.isOpenCodeReady).toBe(true);
 expect(f.state.lastOpenCodeError).toBeNull();
 expect(f.state.openCodeProcess).toBe(currentOwner);
});
it('missing or unsupported verified lifecycle version refuses before the controller starts',async()=>{for(const version of [undefined,'1.18.33','3.0.0','2.1.0-dev']){const f=fixture();f.bundle.version=version;await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'native_runtime_bundle_required'});expect(f.native.start).not.toHaveBeenCalled();}});
it('any other 2.x release requires the pinned upgrade before the controller starts',async()=>{for(const version of ['2.0.20','2.0.25','2.0.27','2.0.30']){const f=fixture();f.bundle.version=version;await expect(f.runtime.startOpenCode()).rejects.toMatchObject({code:'bundle_upgrade_required'});expect(f.native.start).not.toHaveBeenCalled();}});
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
it('artifact failure never falls back to a standalone executable or marks ready',async()=>{const f=fixture({getRuntimeBundle:()=>({version:'2.1.4',descriptor:{generation:2,projectMap:[{targetDirectory:process.cwd()}]},verify:async()=>{throw Object.assign(Error('invalid'),{code:'native_runtime_artifacts_unverified'});}})});await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});expect(f.children).toHaveLength(0);expect(f.events).not.toContain('agents');expect(f.state.isOpenCodeReady).toBe(false);});
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
    startupNotices: () => [],
  });
  const f = fixture({ state: composition.state, syncToHmrState: composition.syncToHmrState });
  expect(composition.getHealthSnapshot()).toMatchObject({ openCodeVersion: null, openCodeRunning: false,
    openCodeStartup: { state: 'idle', attempt: 0, code: null } });
  await f.runtime.bootstrapOpenCodeAtStartup();
  expect(hmrState).toMatchObject({ openCodeVersion: '2.1.4', openCodePort: 43100 });
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
      openCodeVersion: '2.1.4', openCodePort: 43100,
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
it('a refused upgrade launches the retained older reviewed runtime for this process; another version still refuses',async()=>{
 const {recordStartupBundleUpgradeFailure}=await import('./runtime-host/bundle-startup-upgrade-status.js');
 recordStartupBundleUpgradeFailure('bundle_v2_upgrade_compatibility_required',undefined,'2.0.30');
 try{
  const other=fixture();other.bundle.version='2.0.26';
  await expect(other.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'bundle_upgrade_required',message:expect.stringContaining('OpenCode 2.0.26 must be upgraded to 2.0.30')});
  expect(other.native.start).not.toHaveBeenCalled();
  const f=fixture();f.bundle.version='2.0.30';
  await f.runtime.bootstrapOpenCodeAtStartup();
  expect(f.native.start).toHaveBeenCalledTimes(1);expect(f.state.openCodeVersion).toBe('2.0.30');
 }finally{recordStartupBundleUpgradeFailure(null);}
 const f=fixture();f.bundle.version='2.0.30';
 await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'bundle_upgrade_required'});
});
it('a supported runtime below the version pin refuses before launch and names the recorded startup upgrade failure',async()=>{
 const f=fixture();f.bundle.version='2.0.20';
 await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'bundle_upgrade_required',message:expect.stringContaining('OpenCode 2.0.20 must be upgraded to 2.1.4')});
 expect(f.native.start).not.toHaveBeenCalled();expect(f.events).toEqual([]);expect(f.state.lastOpenCodeError).toMatch(/Restart DevRyan to retry the upgrade\.$/);
 const {recordStartupBundleUpgradeFailure}=await import('./runtime-host/bundle-startup-upgrade-status.js');recordStartupBundleUpgradeFailure('bundle_upgrade_owner_active');
 try{await expect(f.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({message:expect.stringContaining('the startup upgrade did not complete (bundle_upgrade_owner_active)')});}
 finally{recordStartupBundleUpgradeFailure(null);}
 expect(f.native.start).not.toHaveBeenCalled();
});

it('a refused same-version upgrade launches the retained runtime; a version below the pin still refuses with its diagnostic',async()=>{
 const {recordStartupBundleUpgradeFailure}=await import('./runtime-host/bundle-startup-upgrade-status.js');
 const diagnostic={stage:'reviewed_asset',reason:'reviewed_asset_mismatch',artifact:'DevRyan-Claude-darwin-arm64',purpose:'bundle-source'};
 recordStartupBundleUpgradeFailure('native_runtime_artifacts_unverified',{diagnostic});
 try {
  const f=fixture();
  await f.runtime.bootstrapOpenCodeAtStartup();
  expect(f.native.start).toHaveBeenCalledTimes(1);expect(f.state.isOpenCodeReady).toBe(true);
  const below=fixture();below.bundle.version='2.0.20';
  await expect(below.runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({code:'native_runtime_artifacts_unverified',diagnostic});
  expect(below.native.start).not.toHaveBeenCalled();
  expect(below.state.openCodeStartup).toMatchObject({state:'failed',diagnostic});
 }finally{recordStartupBundleUpgradeFailure(null);}
});

it.each(['verification','readiness'])('queues one restart behind startup %s',async stage=>{
 let release;
 const blocked=new Promise(resolve=>{release=resolve;});
 const probe=vi.fn().mockImplementationOnce(()=>blocked).mockResolvedValue({ready:true,generation:2});
 const f=fixture(stage==='readiness'?{probeOpenCodeReadiness:probe}:{});
 if(stage==='verification')f.bundle.verify=vi.fn().mockImplementationOnce(()=>blocked).mockResolvedValue(undefined);
 const boot=f.runtime.bootstrapOpenCodeAtStartup();
 await vi.waitFor(()=>expect(stage==='verification'?f.bundle.verify:probe).toHaveBeenCalledOnce());
 const restart=f.runtime.restartOpenCode(),duplicate=f.runtime.restartOpenCode();
 await Promise.resolve();expect(f.state.openCodeStartup.attempt).toBe(1);
 release({ready:true,generation:2});await Promise.all([boot,restart,duplicate]);
 expect(f.native.start).toHaveBeenCalledTimes(2);
 expect(f.children).toHaveLength(2);expect(f.children[0].exited).toBe(true);
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:2,code:null});
 expect(f.state.currentRestartPromise).toBeNull();
});
it('a queued restart recovers a failed boot and retains its own failure for a later retry',async()=>{
 let rejectBoot;
 const f=fixture();f.bundle.verify=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectBoot=reject;}))
  .mockRejectedValueOnce(Object.assign(Error('replacement failed'),{code:'native_replacement_failed'})).mockResolvedValue(undefined);
 const boot=f.runtime.startOpenCode();const bootFailure=expect(boot).rejects.toThrow('boot failed');
 await vi.waitFor(()=>expect(rejectBoot).toBeTypeOf('function'));
 const restart=f.runtime.restartOpenCode();const restartFailure=expect(restart).rejects.toMatchObject({code:'native_replacement_failed'});
 rejectBoot(Error('boot failed'));await Promise.all([bootFailure,restartFailure]);
 expect(f.state.openCodeStartup).toEqual({state:'failed',attempt:2,code:'native_replacement_failed'});
 expect(f.state.currentRestartPromise).toBeNull();await f.runtime.restartOpenCode();
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:3,code:null});
});
it.each([true,false])('project preparation joins native verification before checking captured locations: %s',async captured=>{
 let releaseVerification,starting;const directory=process.cwd();
 const f=fixture();f.bundle.verify=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{releaseVerification=resolve;})).mockResolvedValue(undefined);
 // Match the native owner's single-flight behavior that exposed the original race.
 const launch=f.native.start.getMockImplementation();
 f.native.start.mockImplementation(options=>starting??=(launch(options).finally(()=>{starting=undefined;})));
 let snapshotLocations=[];
 f.native.getConfigurationSnapshot=()=>({locations:snapshotLocations});
 const boot=f.runtime.bootstrapOpenCodeAtStartup();
 await vi.waitFor(()=>expect(releaseVerification).toBeTypeOf('function'));
 expect(f.runtime.startOpenCode()).toBe(boot);
 const source=readFileSync(new URL('../../application.js',import.meta.url),'utf8');
 const composition=source.slice(source.indexOf('  const ensureNativeDirectory='),source.indexOf('  const waitForOpenCodeReady ='));
 const restartOpenCode=vi.fn(async()=>{await f.runtime.restartOpenCode();snapshotLocations=[{directory}];});
 const ensure=runInNewContext(composition+';ensureNativeDirectory',{nativeBundle:{prepareLocations:async()=>[{directory}]},
  nativeRuntime:f.native,openCodeLifecycleRuntime:f.runtime,restartOpenCode,getAuthoritativeActiveSessionCount:async()=>0});
 const settings={projects:[{path:directory}],lastDirectory:directory};
 let preparation;
 const app=express();app.use(express.json());
 registerOpenCodeRoutes(app,{readSettingsFromDiskMigrated:async()=>settings,persistSettings:async()=>settings,
  ensureNativeDirectory:value=>{preparation=ensure(value);return preparation;},markConfigChange:async()=>({})});
 const response=await request(app).put('/api/config/settings').send({lastDirectory:directory});
 expect(response.status).toBe(200);expect(preparation?.then).toBeTypeOf('function');
 expect(f.state.openCodeStartup.attempt).toBe(1);
 if(captured)snapshotLocations=[{directory}];
 releaseVerification();await Promise.all([boot,preparation]);
 expect(restartOpenCode).toHaveBeenCalledTimes(captured?0:1);
 expect(f.native.start).toHaveBeenCalledTimes(captured?1:2);
 expect(f.state.openCodeStartup).toEqual({state:'ready',attempt:captured?1:2,code:null});
});

it('managed-task preflight refusal leaves the ready controller and browser admission intact', async () => {
 const f=fixture({withManagedRuntimeRestart:async()=>{throw Object.assign(Error('Tasks must settle'),{code:'bundle_task_unsettled'});}});
 await f.runtime.startOpenCode();f.events.length=0;
 await expect(f.runtime.applyOpenCodeConfigChanges({scopes:['agents']})).rejects.toMatchObject({code:'bundle_task_unsettled'});
 expect(f.events).toEqual([]);expect(f.children[0].exited).toBeUndefined();
 expect(f.state.isOpenCodeReady).toBe(true);expect(f.state.openCodeStartup.state).toBe('ready');expect(f.state.currentRestartPromise).toBeNull();
});
it('managed-task dispatch stays held across teardown, verification and readiness', async () => {
 let held=false;const f=fixture({withManagedRuntimeRestart:async action=>{held=true;try{return await action();}finally{held=false;}}});
 await f.runtime.startOpenCode();f.events.length=0;
 const start=f.native.start.getMockImplementation();f.native.start.mockImplementation(async options=>{expect(held).toBe(true);return start(options);});
 await f.runtime.restartOpenCode();expect(held).toBe(false);expect(f.events).toEqual(['pause','exit','verify','agents','probe','resume']);
});
