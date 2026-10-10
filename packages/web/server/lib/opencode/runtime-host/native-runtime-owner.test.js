import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyNativeBootMigration} from './native-boot-migration.js';
import {resolveSqliteDriver} from '../db-maintenance-core.js';
import { createNativeRuntimeOwner, loadNativeRuntimeBundle } from './native-runtime-owner.js';
import * as nativeArtifacts from './native-artifacts.js';
import { createNativeCursorRecovery } from './native-cursor-recovery.js';
import {createCursorSdkRuntime} from '../../../../../cursor-sdk-runtime/index.js';

const transport = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(), stop: vi.fn() }));
const primaryStepOptions = vi.hoisted(() => []);
vi.mock('./primary-step-owner.js', async importOriginal => {
 const original = await importOriginal();
 return {...original, createNativePrimaryStepOwner: options => {
  primaryStepOptions.push(options);
  return original.createNativePrimaryStepOwner(options);
 }};
});
vi.mock('./native-process.js', () => ({ createNativeControllerProcess: transport.create }));
vi.mock('../../orchestration/private-host.js', () => ({ createManagedOrchestrationPrivateHost: () => ({ start: transport.start, stop: transport.stop }) }));
afterEach(() => vi.resetAllMocks());

const fixture = async (action, cursorRuntime, configure) => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/native-owner-'));
  try {
    const opencodeDatabasePath=path.join(root,'native.db');await fs.writeFile(opencodeDatabasePath,'');const db=resolveSqliteDriver().open(opencodeDatabasePath);db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,time_archived INTEGER,revert TEXT);CREATE TABLE session_inbox(id TEXT,session_id TEXT,enqueued_seq INTEGER);CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,data TEXT);CREATE TABLE session_pending(id TEXT);`);db.close();
    const migrationReceiptPath = path.join(root, 'migration.json'); await fs.writeFile(migrationReceiptPath, '{}');
    transport.start.mockResolvedValue({ DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:1', DEVRYAN_ORCHESTRATION_TOKEN: 'private-fixture' });
    transport.stop.mockResolvedValue();
    const drain = vi.fn(async () => {}), settleController = vi.fn(async () => {});
    const runtime = { nativeRetentionHolds: async()=>[], nativeRemovals: vi.fn(async () => []), nativeTransactionHolds: async () => [], nativeShellContinuations: async () => [],
      recoverNativeTransientHolds: vi.fn(async () => 0), nativeExecutionContinuations: async () => [] };
    const ownerOptions = {
      bundle: { descriptor: { bundleID: 'fixture', preparedManifestPath: path.join(root, 'prepared.json'), migrationReceiptPath,
        launch: {opencodeDatabasePath, webDataDirectory: root, global: { log: root } } }, artifacts: { manifest: { buildId: 'fixture' } }, configuration: {},
        locations: [{ directory: root }], reviewedPlugins: [], verify: async () => {} },
      primaryRuntime:{setRecoveredInputOwner:vi.fn(),nativeStartupRecords:async()=>[],readRecord:async()=>null},
      executionHost: { runtime, drain, settleController }, admission: {withSessionLock:async(_id,action)=>action()}, openCodeClient: { sessions: {} },
      authorization: { captureWebAuthorization: async () => async () => {}, authorizeOperation: async () => {} },
      cursorRuntime,
    };
    await configure?.(ownerOptions, root);
    const owner = createNativeRuntimeOwner(ownerOptions);
    await action({ owner, drain, settleController, runtime, root });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('a coherent clone reseal after verification cannot replace the selected prepared hash or spawn a controller', async () => {
 let verified = false, boot, reseal;
 const hash = bytes => createHash('sha256').update(bytes).digest('hex');
 await fixture(async ({owner}) => {
  await expect(owner.start()).rejects.toMatchObject({code:'native_clone_evidence_invalid'});
  expect(verified).toBe(true); expect(transport.create).not.toHaveBeenCalled();
  // The replacement is internally coherent; a newly recomputed trust root
  // would accept it. Only the original selection pin must authorize startup.
  const replacement = {...boot,migrationEvidence:{...boot.migrationEvidence,
   sha256:hash(await fs.readFile(boot.migrationEvidence.path)),clone:{...boot.migrationEvidence.clone,
    preparedManifestSha256:hash(await fs.readFile(boot.migrationEvidence.clone.preparedManifestPath))}}};
  await expect(verifyNativeBootMigration(replacement)).resolves.toMatchObject({bundleID:'foreign-origin'});
  await owner.close();
 },undefined,async (options,root) => {
  const descriptor=options.bundle.descriptor;
  await fs.mkdir(path.join(root,'opencode'));await fs.mkdir(path.join(root,'sources'));
  const databasePath=path.join(root,'opencode/opencode.db');await fs.rename(descriptor.launch.opencodeDatabasePath,databasePath);
  descriptor.launch.opencodeDatabasePath=databasePath;descriptor.sourceBundleID='original-A';
  descriptor.migrationReceiptPath=path.join(root,'sources/migration.json');
  options.bundle.artifacts.manifestSha256='b'.repeat(64);
  const write=async (file,value)=>{const bytes=Buffer.from(JSON.stringify(value));await fs.writeFile(path.join(root,file),bytes);return hash(bytes);};
  reseal=async generation=>{
   const origin={bundleID:generation===1?'original-A':'foreign-origin',databasePath:path.join(root,'not-read-A/opencode/opencode.db')};
   await write('descriptor.json',{schema:1,generation:2,bundleID:descriptor.bundleID,sourceBundleID:descriptor.sourceBundleID,createdAt:generation,
    launch:{opencodeDatabasePath:databasePath,artifactManifestSha256:options.bundle.artifacts.manifestSha256},
    preparedManifestPath:descriptor.preparedManifestPath,migrationReceiptPath:descriptor.migrationReceiptPath});
   await write('sources/clone.json',{schema:1,sourceBundleID:descriptor.sourceBundleID,migrationOrigin:origin,
    sourceCredentialSha256:'c'.repeat(64),sourceDescriptorSha256:'d'.repeat(64),sourcePreparedManifestSha256:'e'.repeat(64),
    compatibility:{protocol:'devryan-v2-clone/1',sourceBundleID:descriptor.sourceBundleID,sourceManifestSha256:'a'.repeat(64),targetManifestSha256:options.bundle.artifacts.manifestSha256}});
   await write('sources/migration.json',{protocol:'devryan-native-migration/1',requestID:'migration-A',...origin,status:'completed',nativeVersion:'2.0.20',marker:'not-needed',
    sourceInventorySha256:await write('sources/migration.json.source.json',{generation}),verificationSha256:await write('sources/migration.json.verification.json',{generation})});
   const files=['descriptor.json','sources/clone.json','sources/migration.json','sources/migration.json.source.json','sources/migration.json.verification.json'];
   const immutableFiles=await Promise.all(files.map(async file=>({path:file,sha256:hash(await fs.readFile(path.join(root,file)))})));
   return write('prepared.json',{schema:1,bundleID:descriptor.bundleID,descriptorSha256:immutableFiles[0].sha256,immutableFiles});
  };
  options.bundle.preparedManifestSha256=await reseal(1);
  boot={bundleID:descriptor.bundleID,databasePath,manifestSha256:options.bundle.artifacts.manifestSha256,
   migrationEvidence:{path:descriptor.migrationReceiptPath,sha256:hash(await fs.readFile(descriptor.migrationReceiptPath)),
    clone:{preparedManifestPath:descriptor.preparedManifestPath,preparedManifestSha256:options.bundle.preparedManifestSha256}}};
  options.bundle.verify=async()=>{await verifyNativeBootMigration(boot);verified=true;};
  options.bundle.refreshLocations=async()=>{expect(verified).toBe(true);await reseal(2);};
 });
});

test('launch verifies once before lifecycle configuration and refuses its failure before controller spawn',async()=>{
 const events=[];
 await fixture(async({owner})=>{
  await expect(owner.start({beforeConfiguration:async()=>{events.push('configuration');throw Error('config refused');}})).rejects.toThrow('config refused');
  expect(events).toEqual(['verified','configuration']);expect(transport.create).not.toHaveBeenCalled();
  await owner.close();
 },undefined,options=>{options.bundle.verify=async()=>{events.push('verified');};});
 events.length=0;
 await fixture(async({owner})=>{
  await expect(owner.start({beforeConfiguration:async()=>{events.push('configuration');}})).rejects.toThrow('verify refused');
  expect(events).toEqual(['verified']);expect(transport.create).not.toHaveBeenCalled();await owner.close();
 },undefined,options=>{options.bundle.verify=async()=>{events.push('verified');throw Error('verify refused');};});
});

test('startup passes fresh original Cursor declarations without account discovery or secret fields',async()=>{
 const cursor=createCursorSdkRuntime({storageDir:path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/unused-cursor-declarations'),env:{},ripgrepPath:'/usr/bin/true',nativeWarming:false,
  readAuth:()=>{throw Error('Unexpected credential read');},loadSdk:async()=>{throw Error('Unexpected SDK load');}});
 try{await fixture(async({owner})=>{
  let launch,exited=false;
  const child={bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>null,
   close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};
  transport.create.mockImplementation(async options=>{launch=options;return child;});
  cursor.getCachedVirtualProvider().models.foreign={id:'foreign'};
  await owner.start();
  expect(launch.boot.cursorCatalog.id).toBe('cursor-acp');
  expect(launch.boot.cursorCatalog.models.find(row=>row.id==='composer-2.5')).toEqual({id:'composer-2.5',variants:[]});
  expect(launch.boot.cursorCatalog.models.some(row=>row.id==='foreign')).toBe(false);
  expect(launch.boot.cursorCatalog.models.every(row=>Object.keys(row).sort().join(',')==='id,variants')).toBe(true);
  await owner.close();
 },cursor);}finally{await cursor.dispose();}
});

test('verified replacement recovers only current and proved source holds before fresh admission', async () => {
  const events = [];
  await fixture(async ({ owner, runtime, root }) => {
    let launch, exited = false;
    transport.create.mockImplementation(async options => {
      launch = options; events.push('bound');
      return { bound: { catalog: { asserted: true } }, hasExited: () => exited,
        call: async input => { events.push(input.action); return null; },
        close: async () => { exited = true; await launch.afterExit({}); }, killForRecovery: async () => {} };
    });
    runtime.recoverNativeTransientHolds.mockImplementation(async input => {
      expect(input.directory).toBe(root); events.push(`recover:${input.ownerID}`); return 0;
    });
    await owner.start();
    expect(events).toEqual(['verified', 'bound', 'open-recovery', 'recover:fixture', 'recover:original-A', 'open']);
    await owner.close();
  }, undefined, async options => {
    const descriptor = options.bundle.descriptor;
    descriptor.sourceBundleID = 'original-A'; descriptor.checkpoint = { generation: 2, ownerID: 'original-A' };
    await fs.writeFile(descriptor.preparedManifestPath, '{}');
    options.bundle.preparedManifestSha256 = createHash('sha256').update('{}').digest('hex');
    options.bundle.verify = async () => { events.push('verified'); };
  });
});

test('only the selected artifact exact Stop contract enables the primary handoff disposition', async () => {
 for (const [contracts, expected] of [[undefined,false], [['devryan.foreign-stop/1'],false], [['devryan.primary-step-stop/1'],true]]) {
  primaryStepOptions.length = 0;
  await fixture(async ({owner}) => {
   let launch, exited = false;
   transport.create.mockImplementation(async options => {
    launch = options;
    return {bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>null,
     close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};
   });
   try {
    await owner.start();
    expect(primaryStepOptions).toHaveLength(1);
    expect(primaryStepOptions[0].allowStopHandoff).toBe(expected);
   } finally {await owner.close();}
  }, undefined, options => {options.bundle.artifacts.manifest.compiledContracts = contracts;});
 }
});

test('bundle controllers always use the selected verified supervisor and preserve only additional denied roots', async () => {
 for (const mode of ['default', 'disabled', 'additional-denials']) {
  let selectedLauncher, deniedReadDirectories;
  await fixture(async ({owner, root}) => {
   let launch, exited = false;
   transport.create.mockImplementation(async options => {
    launch = options;
    return {bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>null,
     close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};
   });
   try {
    await owner.start();
    expect(launch.supervisor).toEqual({launcher:selectedLauncher,deniedReadDirectories});
    expect(launch.boot.buildId).toBe('fixture');
    expect(launch.boot.databasePath).toBe(path.join(root,'native.db'));
   } finally {await owner.close();}
  }, undefined, (options, root) => {
   selectedLauncher = path.join(root,'selected-artifact','DevRyan-execution-darwin-arm64');
   options.bundle.artifacts.launcher = selectedLauncher;
   deniedReadDirectories = mode === 'additional-denials' ? [path.join(root,'private-control')] : [];
   if (mode === 'disabled') options.supervisedController = false;
   if (mode === 'additional-denials') options.supervisedController = {
    launcher:path.join(root,'foreign-launcher'),deniedReadDirectories,
   };
  });
 }
});

test('concurrent close finishes private cleanup after a settled startup rejection', () => fixture(async ({ owner, drain }) => {
  let entered, release, exited = false, launch;
  const spawning = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const child = { bound: { catalog: { asserted: false } }, hasExited: () => exited,
    close: async () => { exited = true; await launch.afterExit({}); }, killForRecovery: async () => {} };
  transport.create.mockImplementation(async options => { launch = options; entered(); await blocked; return child; });
  const started = expect(owner.start()).rejects.toMatchObject({ code: 'native_catalog_mismatch' });
  await spawning;
  const closed = expect(owner.close()).rejects.toMatchObject({ code: 'native_catalog_mismatch' });
  release(); await Promise.all([started, closed]);
  expect(drain).toHaveBeenCalledTimes(1); expect(transport.stop).toHaveBeenCalledTimes(1);
  await owner.close(); expect(transport.stop).toHaveBeenCalledTimes(1);
}));

test('catalog refusal retains exact unsupported Cursor effort without opening readiness',()=>fixture(async({owner})=>{
 let launch,exited=false;
 const models=[{providerID:'cursor-acp',id:'composer-2.5',variant:'unsupported'}];
 const child={bound:{catalog:{asserted:false,missing:{models}}},hasExited:()=>exited,
  close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};
 transport.create.mockImplementation(async options=>{launch=options;return child;});
 await expect(owner.start()).rejects.toMatchObject({code:'native_catalog_mismatch',missingCatalog:{models}});
 expect(owner.isReady()).toBe(false);expect(exited).toBe(true);await owner.close();
}));

test('unconfirmed boot keeps private authority alive until actual exit recovery permits close', () => fixture(async ({ owner, drain }) => {
  let launch;
  const failure = Object.assign(new Error('Unconfirmed exit'), { nativeProcessUnsettled: true });
  transport.create.mockImplementation(async options => { launch = options; throw failure; });
  await expect(owner.start()).rejects.toBe(failure);
  await expect(owner.close()).rejects.toBe(failure);
  expect(transport.stop).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled();
  await launch.afterExit({});
  await owner.close();
  expect(drain).toHaveBeenCalledTimes(1); expect(transport.stop).toHaveBeenCalledTimes(1);
}));

test('native startup journals failure before binding and excludes arbitrary error payloads', async () => {
 for (const code of ['native_catalog_read_failed_model_http_500_model_normalize_failed', 'private secret config']) {
  const records=[];
  await fixture(async({owner})=>{
   transport.create.mockRejectedValue(Object.assign(new Error(code),{secret:'private credential'}));
   await expect(owner.start()).rejects.toThrow(code);
   const events=records.filter(row=>row.event==='native_startup');
   expect(events.map(row=>row.payload.phase)).toEqual(['starting','failed']);
   expect(events[1].payload).toMatchObject({stage:'controller',bundleID:'fixture',buildId:'fixture',code:code.startsWith('native_catalog_')?code:'native_startup_failed'});
   expect(events[1].payload.controllerInstanceID).toMatch(/^[a-f0-9-]{36}$/);
   expect(events[1].payload.durationMs).toBeGreaterThanOrEqual(0);
   expect(JSON.stringify(records)).not.toContain('private');
   await owner.close();
  },undefined,options=>{options.recordDiagnostic=entry=>records.push(entry);});
 }
});

test('native startup records bound, ready and physical exit before fallible cleanup', async()=>{
 const records=[];
 await fixture(async({owner,settleController})=>{
  let launch,exited=false;
  transport.create.mockImplementation(async options=>{
   launch=options;return {bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>null,
    close:async()=>{exited=true;await launch.afterExit({pid:123,code:0,signal:null,expected:true,startedAt:Date.now()});},killForRecovery:async()=>{}};
  });
  await owner.start();
  expect(records.filter(row=>row.event==='native_startup').map(row=>row.payload.phase)).toEqual(['starting','bound','ready']);
  settleController.mockRejectedValueOnce(new Error('private cleanup details'));
  await expect(owner.close()).rejects.toThrow('private cleanup details');
  const exit=records.find(row=>row.event==='opencode_process_exit');
  expect(exit.payload).toMatchObject({pid:123,code:0,signal:null,expected:true,bundleID:'fixture',buildId:'fixture'});
  expect(JSON.stringify(records)).not.toContain('private');
 },undefined,options=>{options.recordDiagnostic=entry=>records.push(entry);});
});

test('catalog startup failure is recorded once before cleanup can replace its exception',async()=>{
 const records=[];
 await fixture(async({owner})=>{
  let exited=false;
  transport.create.mockResolvedValue({bound:{catalog:{asserted:false}},hasExited:()=>exited,
   close:async()=>{exited=true;throw new Error('private cleanup failure');},killForRecovery:async()=>{}});
  await expect(owner.start()).rejects.toThrow('private cleanup failure');
  const failures=records.filter(row=>row.event==='native_startup'&&row.payload.phase==='failed');
  expect(failures).toHaveLength(1);expect(failures[0].payload.code).toBe('native_catalog_mismatch');
  expect(JSON.stringify(records)).not.toContain('private');
  await owner.close();
 },undefined,options=>{options.recordDiagnostic=entry=>records.push(entry);});
});

test('startup keeps readiness and web grants closed through durable removal recovery', () => fixture(async ({ owner, runtime, root }) => {
  let entered, release, launch, exited = false;
  const observed = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  // The first read abandons uncommitted automatic retention before opening.
  // Keep this barrier at the original committed-removal recovery phase.
  runtime.nativeRemovals.mockResolvedValueOnce([]).mockImplementation(async () => { entered(); await barrier; return []; });
  const commands = [];
  const child = { bound: { catalog: { asserted: true } }, hasExited: () => exited,
    call: async input => { commands.push(input.action); },
    close: async () => { exited = true; await launch.afterExit({}); }, killForRecovery: async () => {} };
  transport.create.mockImplementation(async options => { launch = options; return child; });
  const starting = owner.start();
  await observed;
  try {
    expect(owner.isReady()).toBe(false);
    expect(owner.isExecutionReady()).toBe(true);
    expect(commands).toEqual(['open-recovery']);
    const spec = { operation: 'sessions.create', method: 'POST', path: '/api/session', directory: root, body: { location: { directory: root } } };
    await expect(owner.nativeOwner.withWebOperation(spec, async () => true)).rejects.toMatchObject({ code: 'native_runtime_not_ready' });
    release(); await starting;
    expect(commands).toEqual(['open-recovery', 'open']);
    expect(owner.isReady()).toBe(true);
    await expect(owner.nativeOwner.withWebOperation(spec, async () => true)).resolves.toBe(true);
  } finally { release(); await starting; await owner.close(); }
  expect(owner.isReady()).toBe(false);
  expect(owner.isExecutionReady()).toBe(false);
}));

test('startup cannot open past an unresolved durable Cursor process intent', () => fixture(async ({ owner, runtime, root }) => {
  runtime.leaseForCall = async () => null;
  runtime.executionOutcomes = async () => [{ outcome: 'uncertain' }];
  const directory = path.join(root, 'harness', 'native-cursor');
  const recovery = createNativeCursorRecovery({ directory, ownerID: 'fixture', runtime });
  const scope = { controllerInstanceID: 'old-fixture', directory: root, sessionID: 'ses_cursor',
    userMessageID: 'msg_user', assistantMessageID: 'msg_cursor', agent: 'build', modelID: 'composer' };
  await recovery.stage({ scope, revision: 0 }); await recovery.starting(scope);
  let launch, exited = false; const commands = [];
  const child = { bound: { catalog: { asserted: true } }, hasExited: () => exited,
    call: async input => { commands.push(input.action); },
    close: async () => { exited = true; await launch.afterExit({}); }, killForRecovery: async () => {} };
  transport.create.mockImplementation(async options => { launch = options; return child; });
  await expect(owner.start()).rejects.toMatchObject({ code: 'native_cursor_recovery_termination_unconfirmed' });
  expect(commands).toEqual(['open-recovery']); expect(owner.isReady()).toBe(false);
  expect((await fs.readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  await owner.close();
}));

test('replacement settles the old controller without terminal host drain; final close stays terminal', () => fixture(async ({ owner, drain, settleController }) => {
  const children = [];
  transport.create.mockImplementation(async launch => {
    let exited = false;
    const child = { instanceID: launch.boot.instanceID, bound: { catalog: { asserted: true } }, hasExited: () => exited,
      call: async () => null,
      close: async () => { if (!exited) { exited = true; await launch.afterExit({}); } },
      killForRecovery: async () => {} };
    children.push(child); return child;
  });
  const first = await owner.start();
  await first.close();
  expect(settleController).toHaveBeenCalledTimes(1); expect(drain).not.toHaveBeenCalled();
  const second = await owner.start(); expect(second).not.toBe(first);
  expect(owner.isReady()).toBe(true); expect(children).toHaveLength(2);
  await owner.close();
  expect(settleController).toHaveBeenCalledTimes(2); expect(drain).toHaveBeenCalledTimes(1);
  expect(owner.isReady()).toBe(false); await owner.close(); expect(drain).toHaveBeenCalledTimes(1);
}));

test('context capture seals same-page native turn anchor and active genuine parts across awaits',async()=>{
 let raw,directory,revoked=false;
 await fixture(async({owner,root})=>{
  directory=root;let launch,exited=false;
  transport.create.mockImplementation(async options=>{launch=options;return {bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>null,
   close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};});
  await owner.start();vi.spyOn(owner.nativeOwner,'captureSessionHookAuthorization').mockResolvedValue(async()=>{if(revoked)throw Error('original_grant_revoked');});
  const user={id:'msg_actual',type:'user',text:'accepted',files:[{mime:'image/png',data:'eA==',name:'image.png'}],time:{created:1}};
  const shell={id:'msg_shell',type:'synthetic',text:'original completed shell',metadata:{source:'shell',jobID:'job_owned'},time:{created:2}};
  raw=[shell,user];const scope={sessionID:'ses_context',directory:root,messageID:shell.id,messageIDs:[user.id,shell.id],permit:{token:'private'}};
  try{
   const captured=await owner.captureContextAssets(scope);
   expect(captured.anchor).toMatchObject({id:shell.id,type:'synthetic'});expect(captured.messages.map(row=>row.info.id)).toEqual([user.id]);await captured.recheck();
   raw=[{...shell,text:'changed same-ID shell body'},user];await expect(captured.recheck()).rejects.toMatchObject({code:'native_context_message_changed'});
   raw=[shell,user];const parts=await owner.captureContextAssets(scope);raw=[shell,{...user,files:[{...user.files[0],data:'eQ=='}]}];
   await expect(parts.recheck()).rejects.toMatchObject({code:'native_context_message_changed'});
   raw=[{...user,id:'msg_new'},shell,user];await expect(owner.captureContextAssets(scope)).rejects.toMatchObject({code:'native_context_message_stale'});
   const summary={id:'msg_summary',type:'compaction',status:'completed',reason:'auto',summary:'Actual text summary',recent:'',time:{created:3}};
   raw=[summary,shell,user];const summaryScope={...scope,messageID:summary.id,messageIDs:[summary.id]};const empty=await owner.captureContextAssets(summaryScope);
   expect(empty.messages).toEqual([]);expect(empty.anchor).toMatchObject({id:summary.id,type:'compaction'});await empty.recheck();
   raw=[{...summary,summary:'changed same-ID summary'},shell,user];await expect(empty.recheck()).rejects.toMatchObject({code:'native_context_message_changed'});
   raw=[summary,shell,user];revoked=true;await expect(owner.captureContextAssets(summaryScope)).rejects.toThrow('original_grant_revoked');revoked=false;
  }finally{await owner.close();}
 },undefined,(options,root)=>{
  options.withCredentialMutationQueue=async action=>action();
  options.bundle.reviewedPlugins=[{id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','process','network','control']}];
  options.bundle.descriptor.launch.global={log:root,state:root,cache:root,tmp:root};
  options.bundle.resolveConfiguration=async()=>({locations:[{directory:root,configuration:{},compatibility:{slim:{mergedConfig:{image_routing:'auto'}}}}]});
  options.openCodeClient.sessions.get=async()=>({id:'ses_context',directory:root});
  options.clientDependencies={getRuntime:()=>({generation:2,baseUrl:'http://127.0.0.1:1'}),fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/message')?{data:raw}:{data:{id:'ses_context',location:{directory},agent:'build',model:{providerID:'fixture',model:'fixture'}}})};
 });
});

test('checkpoint startup binds the real controller without opening recovery or execution admission',()=>fixture(async({owner,runtime,drain})=>{
 let launch,exited=false;const commands=[];
 const child={bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async input=>{commands.push(input.action);},
  close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};
 transport.create.mockImplementation(async options=>{launch=options;return child;});
 expect(()=>owner.checkpointController()).toThrow('bundle_checkpoint_controller_unknown');
 await expect(owner.assertCheckpointAdmissionClosed()).rejects.toMatchObject({code:'bundle_checkpoint_admission_open'});
 await owner.start({admission:'checkpoint'});
 expect(owner.checkpointController()).toBe(child);expect(commands).toEqual([]);expect(owner.isReady()).toBe(false);expect(owner.isExecutionReady()).toBe(false);
 expect(runtime.nativeRemovals).not.toHaveBeenCalled();
 await owner.assertCheckpointAdmissionClosed();await owner.closeAdmissionForCheckpoint();expect(commands).toEqual(['close-startup']);
 await expect(owner.start()).rejects.toMatchObject({code:'native_checkpoint_admission_held'});
 await owner.drainCredentialOwners();await owner.close();expect(exited).toBe(true);expect(drain).toHaveBeenCalledTimes(1);
 await owner.assertCheckpointAdmissionClosed();
}));

test('checkpoint close races an ordinary startup without publishing admission',()=>fixture(async({owner})=>{
 let launch,exited=false,release,entered;const began=new Promise(resolve=>{entered=resolve;});const blocked=new Promise(resolve=>{release=resolve;});const commands=[];
 const child={bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async input=>{commands.push(input.action);},
  close:async()=>{exited=true;await launch.afterExit({});},killForRecovery:async()=>{}};
 transport.create.mockImplementation(async options=>{launch=options;entered();await blocked;return child;});
 const started=owner.start();await began;const closed=owner.closeAdmissionForCheckpoint();release();await Promise.all([started,closed]);
 expect(commands).toEqual(['close-startup']);expect(owner.isReady()).toBe(false);await owner.assertCheckpointAdmissionClosed();await owner.close();
}));

test('native Claude inspection rechecks original web grant, saved profile configuration and held generation',()=>{
 let change,authorize,profileFile,profile;
 return fixture(async({owner,root})=>{
  let launch,exited=false;
  const child={bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>null,close:async()=>{exited=true;await launch.afterExit({});}};
  transport.create.mockImplementation(async options=>{launch=options;child.instanceID=options.boot.instanceID;child.bound.instanceID=options.boot.instanceID;return child;});
  await owner.start();
  expect(await owner.inspectClaude({kind:'status',directory:root})).toMatchObject({loggedIn:true,path:null});
  expect(authorize).toHaveBeenCalledWith({operation:'provider.configuration',scope:'read',directory:root});
  change=async()=>{await fs.writeFile(profileFile,JSON.stringify([{...profile,oauthToken:'synthetic-replaced'}]));};
  await expect(owner.inspectClaude({kind:'status',directory:root})).rejects.toMatchObject({code:'native_provider_configuration_changed'});
  await fs.writeFile(profileFile,JSON.stringify([profile]));change=async()=>{throw Object.assign(new Error('revoked'),{code:'permission_denied',status:403});};
  await expect(owner.inspectClaude({kind:'status',directory:root})).rejects.toMatchObject({code:'permission_denied'});
  change=undefined;await owner.closeAdmissionForCheckpoint();await expect(owner.inspectClaude({kind:'status',directory:root})).rejects.toMatchObject({code:'native_runtime_not_ready'});
  await owner.close();
 },undefined,async(options,root)=>{
  const globals=Object.fromEntries(['home','config','data','state','cache','bin','log','repos','tmp'].map(key=>[key,path.join(root,key)]));for(const directory of Object.values(globals))await fs.mkdir(directory);
  options.bundle.descriptor.launch.global=globals;options.bundle.descriptor.projectMap=[{targetDirectory:root}];
  options.bundle.reviewedPlugins=[{id:'devryan.provider-compat',manifestDigest:'a'.repeat(64),capabilities:['provider']}];
  options.bundle.artifacts.reviewedClaude={};options.withCredentialMutationQueue=async action=>action();
  options.bundle.artifacts.manifest.compiledContracts=['devryan.claude-lifecycle/1'];
  options.bundle.resolveConfiguration=async()=>({locations:[{directory:root,configuration:{},compatibility:{mcp:{}}}]});
  await fs.mkdir(path.join(globals.home,'.config/meridian'),{recursive:true});profileFile=path.join(globals.home,'.config/meridian/profiles.json');
  profile={id:'qa',type:'oauth-token',credentialPolicy:'access-only',oauthToken:'synthetic',oauthTokenExpiresAt:Date.now()+3600000};await fs.writeFile(profileFile,JSON.stringify([profile]));
  authorize=vi.fn(async()=>async()=>{const action=change;change=undefined;await action?.();});options.authorization.captureWebAuthorization=authorize;
 });
});

test('missing Claude capability keeps core startup available and refuses before a settings grant',()=>{
 const authorize=vi.fn(async()=>async()=>{});
 return fixture(async({owner,root})=>{
  let launch,exited=false;const commands=[];
  const child={bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async input=>{commands.push(input.action);},close:async()=>{exited=true;await launch.afterExit({});}};
  transport.create.mockImplementation(async options=>{launch=options;return child;});
  await owner.start();expect(owner.isReady()).toBe(true);expect(commands).toContain('open');
  await expect(owner.inspectClaude({kind:'status',directory:root})).rejects.toMatchObject({code:'native_claude_update_required'});
  expect(authorize).not.toHaveBeenCalled();await owner.close();
 },undefined,options=>{options.authorization.captureWebAuthorization=authorize;});
});

test('normal close retains the physical controller until the credential queue has drained',()=>{
 let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),draining=new Promise(resolve=>{entered=resolve;});const order=[];
 return fixture(async({owner})=>{
  let launch,exited=false;
  const child={bound:{catalog:{asserted:true}},hasExited:()=>exited,call:async()=>{},close:async()=>{order.push('controller-exit');exited=true;await launch.afterExit({});}};
  transport.create.mockImplementation(async options=>{launch=options;return child;});
  await owner.start();const closing=owner.close();await draining;expect(exited).toBe(false);release();await closing;
  expect(order).toEqual(['queue-drained','controller-exit']);
 },undefined,options=>{options.withCredentialMutationQueue=async action=>{entered();await blocked;await action();order.push('queue-drained');};});
});

const loaderBinding=()=>({admission:'pending',descriptor:{bundleID:'selected',generation:2,
  // A relative manifest path makes the artifact check refuse immediately after the bundle gate.
  launch:{artifactManifestPath:'relative-manifest.json',artifactManifestSha256:'0'.repeat(64)}}});

test('fresh verified artifacts are reused only for the exact selected launch and supervisor',async()=>{
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/native-loader-'));
 const verifyArtifacts=vi.spyOn(nativeArtifacts,'verifyNativeRuntimeArtifacts').mockRejectedValue(Error('unexpected artifact rescan'));
 try{
  const launch={artifactManifestPath:path.join(root,'native-bundle.json'),artifactManifestSha256:'a'.repeat(64),controllerBinary:path.join(root,'controller'),writerBinary:path.join(root,'writer'),
   reviewedNativeConfigPath:path.join(root,'reviewed-native.json'),reviewedPluginManifestPath:path.join(root,'reviewed-plugins.json'),global:{tmp:root}};
  await fs.writeFile(launch.reviewedNativeConfigPath,JSON.stringify({schema:1,configuration:{},catalogRequirements:{agents:[],plugins:[],tools:[],models:[]},locations:[{directory:root}]}));
  await fs.writeFile(launch.reviewedPluginManifestPath,JSON.stringify({schema:1,plugins:[]}));
  const descriptor={bundleID:'selected',generation:2,launch,projectMap:[{targetDirectory:root}]};
  const artifacts={manifestPath:launch.artifactManifestPath,manifestSha256:launch.artifactManifestSha256,controller:launch.controllerBinary,writer:launch.writerBinary,launcher:path.join(root,'supervisor'),manifest:{inputs:{reviewedPlugins:[]}}};
  const verified={descriptor,phase:'resume',integrity:'verified',admission:'held',artifacts};
  const binding={controlRoot:root,admission:'pending',descriptor,selection:{preparedManifestSha256:'b'.repeat(64)}};
  const loaded=await loadNativeRuntimeBundle({binding,launcher:artifacts.launcher,verified});
  expect(loaded.artifacts).toBe(artifacts);expect(verifyArtifacts).not.toHaveBeenCalled();
  for(const mutation of [{manifestPath:path.join(root,'other.json')},{manifestSha256:'c'.repeat(64)},{launcher:path.join(root,'other-supervisor')},{controller:path.join(root,'other-controller')},{writer:path.join(root,'other-writer')}]){
   await expect(loadNativeRuntimeBundle({binding,launcher:artifacts.launcher,verified:{...verified,artifacts:{...artifacts,...mutation}}})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
  }
 }finally{verifyArtifacts.mockRestore();await fs.rm(root,{recursive:true,force:true});}
});

test('boot hands its fresh verification to the loader instead of rescanning the bundle',async()=>{
  const verify=vi.fn(async()=>{throw new Error('unexpected second verification');});
  await expect(loadNativeRuntimeBundle({binding:loaderBinding(),launcher:'/launcher',verify,
    verified:{descriptor:{bundleID:'selected'},phase:'resume',integrity:'verified',admission:'held'}}))
    .rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
  expect(verify).not.toHaveBeenCalled();
});

test('the loader verifies itself without a hand-off and fails closed on a mismatched one',async()=>{
  const verify=vi.fn(async()=>({descriptor:{bundleID:'selected'},phase:'resume',integrity:'verified',admission:'held'}));
  await expect(loadNativeRuntimeBundle({binding:loaderBinding(),launcher:'/launcher',verify}))
    .rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
  expect(verify).toHaveBeenCalledTimes(1);
  verify.mockClear();
  for(const verified of [null,{descriptor:{bundleID:'other'},phase:'resume',integrity:'verified'},
    {descriptor:{bundleID:'selected'},phase:'prepared',integrity:'verified'},{descriptor:{bundleID:'selected'},phase:'resume'}]){
    await expect(loadNativeRuntimeBundle({binding:loaderBinding(),launcher:'/launcher',verify,verified}))
      .rejects.toMatchObject({code:'runtime_bundle_recomposition_required'});
  }
  await expect(loadNativeRuntimeBundle({binding:{...loaderBinding(),admission:'held'},launcher:'/launcher',verify,
    verified:{descriptor:{bundleID:'selected'},phase:'resume',integrity:'verified'}})).rejects.toMatchObject({code:'runtime_bundle_reconciliation_required'});
  expect(verify).not.toHaveBeenCalled();
});
