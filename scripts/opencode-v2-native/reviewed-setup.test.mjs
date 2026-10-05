import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {createReviewedSetupSession,reviewedSetupFamilies,reviewedSetupRegistrations,assertReviewedSetupBoot,attachReviewedSetup} from './reviewed-setup.mjs';
import {createHttpProviderConfiguration} from './http-provider.mjs';
import {compiledHelperAgentIDs,createCompiledHelperAgentFixture} from './package-helper-agent-fixture.mjs';
test('all seven exact active specs map to existing compiled owners without losing manifest provenance',()=>{
 const ids=[...new Set(reviewedSetupFamilies.flatMap(row=>row.origins))];const origins=ids.map(id=>({id,manifestDigest:'a'.repeat(64),capabilities:['control']}));
 const rows=reviewedSetupRegistrations(origins);assert.equal(reviewedSetupFamilies.length,7);assert.equal(rows.length,origins.length);
 for(const row of rows){assert.equal(row.manifestDigest,'a'.repeat(64));assert.ok(row.legacySpecs.length);}
 assert.throws(()=>reviewedSetupRegistrations(origins.filter(row=>row.id!=='devryan.document-reader')),/Required compiled family unavailable/);
});
test('active boot evidence refuses a missing required original command or family',async()=>{
 const names=['deepwork','reflect','loop','interview','ponytail','ponytail-help'];const location={directory:'/owned/project',activeRegistrationIDs:[...new Set(reviewedSetupFamilies.flatMap(row=>row.origins))],configuration:{commands:{}},compatibility:{ponytail:{defaultMode:'full'}}};
 const runtimeOwner={getConfigurationSnapshot:()=>({locations:[location]})};const controller={bound:{catalog:{asserted:true}}};const rows=[];
 const client={catalog:{commands:async input=>{assert.deepEqual(input,{directory:location.directory});return names.map(name=>({name,template:'actual registered original'}));}}};
 await assertReviewedSetupBoot({runtimeOwner,controller,client,onCase:row=>rows.push(row)});assert.equal(rows[0].personalProviderParity,false);
 names.splice(names.indexOf('interview'),1);await assert.rejects(assertReviewedSetupBoot({runtimeOwner,controller,client,onCase:()=>{}}),/Missing original command/);
});

test('browser is explicit fixture activation, never an added saved personal family',()=>{
 const origins=[...new Set(reviewedSetupFamilies.flatMap(row=>row.origins)),'devryan.browser'].map(id=>({id,manifestDigest:'b'.repeat(64),capabilities:['control']}));
 assert.deepEqual(reviewedSetupRegistrations(origins).find(row=>row.id==='devryan.browser').legacySpecs,[]);
 assert.deepEqual(reviewedSetupRegistrations(origins,{browser:true}).find(row=>row.id==='devryan.browser').legacySpecs,['./plugins/devryan-browser.mjs']);
 assert.equal(reviewedSetupFamilies.length,7);
 assert.throws(()=>reviewedSetupRegistrations(origins.filter(row=>row.id!=='devryan.browser'),{browser:true}),/compiled browser unavailable/);
});

test('snapshot preserves genuine saved overrides but does not self-shadow Slim/interview factories',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/reviewed-command-config-'));
 try{
  const directory=path.join(root,'project'),config=path.join(root,'config'),home=path.join(root,'home');
  await Promise.all([directory,config,home].map(value=>fs.mkdir(value)));
  const origins=[...new Set(reviewedSetupFamilies.flatMap(row=>row.origins)),'devryan.browser'].map(id=>({id}));
  const registrationBytes=Buffer.from(JSON.stringify({schema:1,plugins:reviewedSetupRegistrations(origins,{browser:true})}));
  const reviewedPluginManifestPath=path.join(root,'plugins.json'),reviewedNativeConfigPath=path.join(root,'policy.json');
  await fs.writeFile(reviewedPluginManifestPath,registrationBytes);
  await fs.writeFile(reviewedNativeConfigPath,JSON.stringify({schema:1,locations:[{directory}],catalogRequirements:{agents:[],plugins:[],tools:[],models:[]}}));
  const ponytailCommands=Object.fromEntries(['ponytail','ponytail-help','ponytail-audit','ponytail-debt','ponytail-gain','ponytail-review'].map(name=>[name,{template:'actual Ponytail '+name,description:name}]));
  const bundle={reviewedConfiguration:{ponytailCommands,slimCommandDeclarations:{deepwork:{template:'static only'},loop:{template:'static only'}},interviewCommandDeclaration:{template:'static marker'},
   resolveSlimAgents:async input=>({agents:input.hostConfiguration.agent})}};
  const configuration=createHttpProviderConfiguration('http://127.0.0.1:1/v1');configuration.commands={reviewed:{template:'Saved custom $ARGUMENTS'},reflect:{template:'Genuine saved override'}};
  const helperFixture=await createCompiledHelperAgentFixture({root});Object.assign(configuration.agents,helperFixture.agents);
  const unchangedConfiguration=structuredClone(configuration);
  const binding={descriptor:{generation:2,launch:{opencodeConfigDirectory:config,global:{home},reviewedPluginManifestPath,reviewedNativeConfigPath},projectMap:[{targetDirectory:directory}]}};
  const remoteMcp={compiled:{type:'remote',url:'http://127.0.0.1:1/mcp',oauth:false},disabled:{type:'remote',url:'http://127.0.0.1:1/dormant',enabled:false}};
  attachReviewedSetup({bundle,binding,registrationBytes,configuration,browser:true,remoteMcp});remoteMcp.compiled.url='http://127.0.0.1:2/changed';
  const snapshot=await bundle.resolveConfiguration(1),location=snapshot.locations[0];
  assert.deepEqual(configuration,unchangedConfiguration,'Reviewed setup must not mutate supplied fixture defaults');
  assert.deepEqual(location.configuration.model,{providerID:'devryan-smoke',model:'smoke-write'});
  assert.equal(location.configuration.default_agent,'orchestrator');
  assert.deepEqual(location.configuration.agents.title,{disabled:true});
  for(const name of compiledHelperAgentIDs){
   const original=helperFixture.agents[name],effective=location.configuration.agents[name];
   assert.deepEqual(location.compatibility.agents[name],original,'Original production helper body changed');
   assert.deepEqual(effective,{description:original.description,mode:'subagent',hidden:true,system:original.prompt,
    request:{body:{temperature:0}},permissions:[{action:'*',resource:'*',effect:'deny'}]});
   assert.ok(location.requiredCatalogs.agents.includes(name));
  }
  for(const name of ['orchestrator','fixer','designer','council','oracle','explorer','librarian','builder']){
   assert.deepEqual(location.configuration.agents[name],{mode:name==='orchestrator'||name==='builder'?'primary':'subagent',
    model:{providerID:'devryan-smoke',model:'smoke-write',variant:'default'}});
  }
  assert.equal(location.compatibility.legacy.model,'devryan-smoke/smoke-write');
  assert.deepEqual(location.compatibility.slim.mergedConfig.agents.orchestrator.model,['devryan-smoke/smoke-write','devryan-smoke/gpt-5-native-smoke']);
  assert.deepEqual(location.compatibility.slim.mergedConfig.fallback,{enabled:true,maxRetries:0,initialRetryDelayMs:0,retryDelayMs:0});
  assert.equal(snapshot.registrationManifestDigest,createHash('sha256').update(registrationBytes).digest('hex'));
  for(const name of ['deepwork','loop','interview']){assert.equal(location.compatibility.commands[name],undefined);assert.equal(location.configuration.commands[name],undefined);}
  assert.equal(location.configuration.commands.reflect.template,'Genuine saved override');assert.equal(location.configuration.commands.reviewed.template,'Saved custom $ARGUMENTS');
  assert.equal(location.configuration.commands['ponytail-help'].template,'actual Ponytail ponytail-help');
  assert.ok(location.activeRegistrationIDs.includes('devryan.browser'));
  assert.equal(location.compatibility.mcp.compiled.url,'http://127.0.0.1:1/mcp');assert.deepEqual(location.requiredCatalogs.mcp,['compiled']);
  assert.deepEqual(location.compatibility.slim.mergedConfig.disabled_mcps,['websearch','context7','grep_app']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('reviewed root enrolment precedes accepted prompt use and propagates refusal',async()=>{
 const calls=[],input={title:'Owned original role'},directory='/owned/fixture';
 const client={sessions:{create:async(body,options)=>{assert.equal(body,input);assert.deepEqual(options,{directory});calls.push('created');return {id:'ses_real'};}}};
 const session=await createReviewedSetupSession({client,directory,input,admitPrimary:async id=>{assert.equal(id,'ses_real');calls.push('enrolled');}});
 assert.deepEqual(session,{id:'ses_real'});assert.deepEqual(calls,['created','enrolled']);
 await assert.rejects(createReviewedSetupSession({client,directory,input,admitPrimary:async()=>{throw Error('enrolment_refused');}}),/enrolment_refused/);
 await assert.rejects(createReviewedSetupSession({client,directory,input}),/primary enrolment owner required/);
});
