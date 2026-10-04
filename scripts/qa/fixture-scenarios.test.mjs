import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { prepareQaFixtureProfile, runQaFixtureScenario, runQaAgentRuntimeSettingsFixtureProof } from './fixture-scenarios.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';
import { PERF_PARENT_SESSION_ID } from '../perf/fixture-session-seeds.mjs';
import { listConfigAgents } from '../../packages/web/server/lib/opencode/agents.js';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';

const cell={transport:'fixture',providerId:'fixture',modelId:'fixture-model',runtime:'web',scenarioId:'core-journey',agent:'builder',variant:null,planMode:false};
// Constructor contract only; actual native bundle preparation is independently
// exercised by the runtime cells. No controller is launched by this unit suite.
const prepareNativeProfile=async({runtimeRoot})=>{
  const home=path.join(runtimeRoot,'home');
  return {env:{DEVRYAN_RUNTIME_BUNDLE_ROOT:path.join(runtimeRoot,'bundles'),DEVRYAN_OPENCODE_GENERATION:'2',
    HOME:home,DEVRYAN_QA_HOME:home,OPENCODE_CONFIG_DIR:path.join(home,'.config/opencode'),OPENCHAMBER_DATA_DIR:path.join(home,'.config/openchamber'),
    OPENCHAMBER_ELECTRON_USER_DATA_DIR:path.join(runtimeRoot,'browser-profile')},bootstrapPath:'constructor-unit-only',
    verifyInputs:async()=>'a'.repeat(64),close:async()=>{},evidence:{inputDigest:'a'.repeat(64),nativeBundle:{bundleID:'constructor-unit-only'}}};
};
const artifactRoot=path.resolve('.cache/qa/unit-native-artifact-not-launched');

for(const generation of [2]) for(const agent of ['builder','orchestrator']) test(`generation ${generation} fixture ${agent} profile pins private defaults and uses no copied credentials or installed provider runtime`,async () => {
  const project=createQaProjectFixture({runId:'fixture-profile-contract'});let profile;
  try {
    profile=await prepareQaFixtureProfile({runtimeRoot:path.join(project.evidenceDirectory,'runtime'),workspace:project.fixtureRoot,cell:{...cell,agent},generation,artifactRoot,prepareNativeProfile});
    assert.deepEqual(JSON.parse(await readFile(path.join(project.evidenceDirectory,'runtime/credentials.env.json'),'utf8')),{});
    assert.equal(profile.evidence.credentialsCopied,false);
    assert.equal(profile.evidence.fixtureGeneration,generation);
    assert.equal(profile.fixture.generation,generation);
    assert.equal(profile.env.DEVRYAN_OPENCODE_GENERATION,String(generation));
    assert.equal(profile.env.HOME,profile.env.DEVRYAN_QA_HOME);
    assert.equal(profile.env.OPENCODE_SKIP_START,undefined);
    assert.equal(profile.env.OPENCHAMBER_SKIP_OPENCODE_START,undefined);
    assert.equal(profile.env.OPENCODE_HOST,undefined);
    assert.equal(typeof profile.startFacade,'function');
    assert.equal(profile.evidence.runtimeOwner,'actual-private-native-bundle');
    assert.equal(profile.evidence.localElectronIPC,'not-qualified-by-wire');
    assert.equal(profile.env.GH_TOKEN,'');assert.equal(profile.env.GITHUB_TOKEN,'');
    const settings=JSON.parse(await readFile(path.join(profile.env.OPENCHAMBER_DATA_DIR,'settings.json'),'utf8'));
    assert.equal(settings.showReasoningTraces,true);
    assert.equal(settings.defaultModel,'fixture/fixture-model');
    assert.equal(settings.defaultAgent,agent === 'builder' ? 'build' : agent);
    assert.deepEqual(settings.agentModelSelections,Object.fromEntries(['build','builder','orchestrator'].map(name => [name,{providerId:'fixture',modelId:'fixture-model',variant:'low'}])));
    assert.equal(Object.hasOwn(settings,'defaultVariant'),false);
    assert.equal(Object.hasOwn(settings,'agentVariantSelections'),false);
    const slim=JSON.parse(await readFile(path.join(profile.env.OPENCODE_CONFIG_DIR,'oh-my-opencode-slim.json'),'utf8'));
    assert.equal(slim.agents.builder.model,'fixture/fixture-model');
    assert.equal(slim.agents.builder.variant,'low');
    const userConfigPath=path.join(profile.env.OPENCODE_CONFIG_DIR,'opencode.json');
    const nativeConfig=JSON.parse(await readFile(userConfigPath,'utf8'));
    assert.equal(Object.hasOwn(nativeConfig,'openchamber'),false);
    const sidecar=JSON.parse(await readFile(path.join(profile.env.OPENCODE_CONFIG_DIR,'.openchamber/config.json'),'utf8'));
    assert.deepEqual(sidecar.agentOverrides,Object.fromEntries(['build','builder','orchestrator'].map(name => [name,{model:'fixture/fixture-model',variant:'low'}])));
    const configAgents=listConfigAgents(project.fixtureRoot,{userConfigPath,env:{},readOpenCodeConfig:()=>nativeConfig});
    for(const name of ['builder','orchestrator']) {
      const configured=configAgents.find(entry=>entry.name===name);
      assert.deepEqual(configured?.model,{providerID:'fixture',modelID:'fixture-model'});
      assert.equal(configured.variant,'low');
      assert.equal(configured.source,'packaged');
      assert.equal(configured.overrides.model,true);
      assert.equal(configured.overrides.variant,true);
    }
    const client=createOpenCodeClient({getRuntime:()=>({generation,baseUrl:profile.fixture.origin}),getAuthHeaders:()=>profile.fixture.authHeaders});
    const nativeAgents=await client.catalog.agents({directory:project.fixtureRoot});
    assert.equal(nativeAgents.find(agent=>agent.name==='build').variant,'low');
    assert.equal(profile.evidence.agentFallbackVariant,'low');
    assert.equal(profile.evidence.applicationAgentFallbackVariant,'low');
    await assert.rejects(profile.startFacade('https://foreign.invalid'),/exact loopback/);
    const facade=await profile.startFacade('http://127.0.0.1:49152');
    assert.match(facade.origin,/^http:\/\/127\.0\.0\.1:/);
    const launchSettings=JSON.parse(await readFile(path.join(profile.env.OPENCHAMBER_DATA_DIR,'settings.json'),'utf8'));
    assert.equal(launchSettings.desktopLocalPort,49152);
    assert.deepEqual(launchSettings.desktopWindowState,settings.desktopWindowState);
    await assert.rejects(profile.startFacade('http://127.0.0.1:49153'),/already started/);
    const {records:rows}=await client.sessions.messages(PERF_PARENT_SESSION_ID,{limit:50},{directory:project.fixtureRoot});
    assert.equal(rows.length,50);
    assert.ok(rows.some((row) => row.parts.some((part) => part.text?.startsWith('History response'))));
    assert.deepEqual(profile.fixture.getState().unknownRoutes,[]);
    if(generation===2)assert.deepEqual(profile.fixture.getState().locationRequired,[]);
  } finally {await profile?.close();removeQaProjectFixture(project);await rm(project.evidenceDirectory,{recursive:true,force:true});}
});

test('wire cleanup retains bounded owner failure details and attempts every existing owner',async () => {
  const project=createQaProjectFixture({runId:'fixture-cleanup-owner-details'});let profile,facade;
  const attempted=[];
  const rejected=new Error('native transport unsettled: '+ 'x'.repeat(2048));
  try {
    profile=await prepareQaFixtureProfile({runtimeRoot:path.join(project.evidenceDirectory,'runtime'),
      workspace:project.fixtureRoot,cell,generation:2,artifactRoot,
      prepareNativeProfile:async options=>({...await prepareNativeProfile(options),
        close:async()=>{attempted.push('native-profile');throw rejected;}})});
    facade=await profile.startFacade('http://127.0.0.1:49152');
    const closeFacade=facade.close,closeFixture=profile.fixture.close;
    facade.close=async()=>{attempted.push('facade');await closeFacade();};
    profile.fixture.close=async()=>{attempted.push('fixture');await closeFixture();};
    await assert.rejects(profile.close(),error=>{
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors,[rejected]);
      assert.equal(error.message,`QA wire cleanup failed: native-profile: ${rejected.message.slice(0,512)}`);
      assert.ok(error.message.length<600);
      return true;
    });
    assert.deepEqual(attempted.sort(),['facade','fixture','native-profile']);
    // Real fixture/facade servers have also closed despite the sibling rejection.
    await assert.rejects(fetch(facade.origin),/fetch failed/);
    await assert.rejects(fetch(profile.fixture.origin),/fetch failed/);
  } finally {await Promise.allSettled([facade?.close(),profile?.fixture.close()]);removeQaProjectFixture(project);await rm(project.evidenceDirectory,{recursive:true,force:true});}
});

test('fixture profiles reject live/unsupported cases and symlink escapes before starting a fixture',async () => {
  const project=createQaProjectFixture({runId:'fixture-profile-safety'});
  try {
    const options={runtimeRoot:path.join(project.evidenceDirectory,'runtime'),workspace:project.fixtureRoot,cell,artifactRoot,prepareNativeProfile};
    await assert.rejects(prepareQaFixtureProfile({...options,artifactRoot:undefined}),/explicit native artifacts/);
    await assert.rejects(prepareQaFixtureProfile({...options,generation:1}),/fixture generation/);
    await assert.rejects(prepareQaFixtureProfile({...options,generation:3}),/fixture generation/);
    for (const patch of [{transport:'live'},{providerId:'openai'},{scenarioId:'compaction-natural'},{scenarioId:'project-work'},{runtime:'electron',scenarioId:'mobile'},{agent:'plan'},{variant:'medium'},{planMode:'true'}]) {
      await assert.rejects(prepareQaFixtureProfile({...options,cell:{...cell,...patch}}),/Unsupported/);
    }
    const link=path.join(project.evidenceDirectory,'escape');await symlink('/tmp',link);
    await assert.rejects(prepareQaFixtureProfile({...options,runtimeRoot:path.join(link,'qa-must-not-create')}),/owned repository cache/);
    await assert.rejects(runQaFixtureScenario({cell:{...cell,scenarioId:'project-work'}}),/Unsupported/);
  } finally {removeQaProjectFixture(project);await rm(project.evidenceDirectory,{recursive:true,force:true});}
});

for (const runtime of ['web','electron']) test(`${runtime} settings proof drives the UI, records unknown external application and restores desired values`,async () => {
  let lsp=true;let reloads=0;let toggles=0;const writes=[];const screenshots=[];
  const api=async(_route,options)=>{
    if(options?.method==='PUT'){writes.push(JSON.parse(options.body));lsp=JSON.parse(options.body).lsp;}
    return {lsp,appliesOnRestart:true,runtimeMode:'external',appliedLsp:null,restartRequired:null};
  };
  const ui={
    click:async options=>{if(options.selector?.startsWith('[role="switch"]')){lsp=!lsp;toggles++;}},
    reveal:async()=>{},waitExpression:async()=>true,
    waitFor:async(_label,predicate)=>{const value=await predicate();assert.ok(value);return value;},
    reload:async()=>{reloads++;},
  };
  const result=await runQaAgentRuntimeSettingsFixtureProof({cell:{...cell,runtime},ui,api,screenshot:async name=>screenshots.push(name)});
  assert.equal(result.managedReadiness,false);assert.equal(toggles,1);assert.equal(reloads,1);
  assert.equal(result.saved.lsp,false);assert.equal(result.reloaded.lsp,false);assert.equal(result.restored.lsp,true);
  assert.deepEqual(writes,[{lsp:true}]);assert.deepEqual(screenshots,['fixture-agent-runtime-settings']);
});

test('settings proof restores its sidecar after a reload failure and rejects live transports before mutation',async () => {
  let lsp=true;let calls=0;const writes=[];
  const api=async(_route,options)=>{
    calls++;
    if(options?.method==='PUT'){writes.push(JSON.parse(options.body));lsp=JSON.parse(options.body).lsp;}
    return {lsp,runtimeMode:'external',appliedLsp:null,restartRequired:null};
  };
  await assert.rejects(runQaAgentRuntimeSettingsFixtureProof({cell:{...cell,transport:'live'},api}),/private desktop fixture/);
  assert.equal(calls,0);
  const ui={click:async options=>{if(options.selector?.startsWith('[role="switch"]'))lsp=!lsp;},
    reveal:async()=>{},waitExpression:async()=>true,waitFor:async(_label,predicate)=>predicate(),
    reload:async()=>{throw new Error('renderer reload failed');}};
  await assert.rejects(runQaAgentRuntimeSettingsFixtureProof({cell,ui,api,screenshot:async()=>{}}),/renderer reload failed/);
  assert.equal(lsp,true);assert.deepEqual(writes,[{lsp:true}]);
});
