import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { prepareQaFixtureProfile, runQaFixtureScenario } from './fixture-scenarios.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';
import { PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';
import { listConfigAgents } from '../../packages/web/server/lib/opencode/agents.js';

const cell={transport:'fixture',providerId:'fixture',modelId:'fixture-model',runtime:'web',scenarioId:'core-journey',agent:'builder',variant:null,planMode:false};

for(const agent of ['builder','orchestrator']) test(`fixture ${agent} profile pins private defaults and uses no copied credentials or installed provider runtime`,async () => {
  const project=createQaProjectFixture({runId:'fixture-profile-contract'});let profile;
  try {
    profile=await prepareQaFixtureProfile({runtimeRoot:path.join(project.evidenceDirectory,'runtime'),workspace:project.fixtureRoot,cell:{...cell,agent}});
    assert.deepEqual(JSON.parse(await readFile(path.join(project.evidenceDirectory,'runtime/credentials.env.json'),'utf8')),{});
    assert.equal(profile.evidence.credentialsCopied,false);
    assert.equal(profile.env.OPENCODE_SKIP_START,'true');
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
    const nativeAgents=await fetch(`${profile.fixture.origin}/agent`).then(response=>response.json());
    assert.equal(nativeAgents.find(agent=>agent.name==='build').variant,'low');
    assert.equal(profile.evidence.agentFallbackVariant,'low');
    assert.equal(profile.evidence.applicationAgentFallbackVariant,'low');
    const rows=await fetch(`${profile.fixture.origin}/session/${PERF_PARENT_SESSION_ID}/message?limit=50`).then((response) => response.json());
    assert.equal(rows.length,50);
    assert.ok(rows.some((row) => row.parts.some((part) => part.text?.startsWith('History response'))));
  } finally {await profile?.close();removeQaProjectFixture(project);await rm(project.evidenceDirectory,{recursive:true,force:true});}
});

test('fixture profiles reject live/unsupported cases and symlink escapes before starting a fixture',async () => {
  const project=createQaProjectFixture({runId:'fixture-profile-safety'});
  try {
    const options={runtimeRoot:path.join(project.evidenceDirectory,'runtime'),workspace:project.fixtureRoot,cell};
    for (const patch of [{transport:'live'},{providerId:'openai'},{scenarioId:'compaction-natural'},{scenarioId:'project-work'},{runtime:'electron',scenarioId:'mobile'},{agent:'plan'},{variant:'medium'},{planMode:'true'}]) {
      await assert.rejects(prepareQaFixtureProfile({...options,cell:{...cell,...patch}}),/Unsupported/);
    }
    const link=path.join(project.evidenceDirectory,'escape');await symlink('/tmp',link);
    await assert.rejects(prepareQaFixtureProfile({...options,runtimeRoot:path.join(link,'qa-must-not-create')}),/owned repository cache/);
    await assert.rejects(runQaFixtureScenario({cell:{...cell,scenarioId:'project-work'}}),/Unsupported/);
  } finally {removeQaProjectFixture(project);await rm(project.evidenceDirectory,{recursive:true,force:true});}
});
