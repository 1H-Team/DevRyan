import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeConfigurationSnapshotResolver} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js';
import {parseMdFile} from '../../packages/web/server/lib/opencode/shared.js';
import {packageSkillsForLaunch} from './package-skill-lane.mjs';
import {compiledCouncilMembers} from './package-council-lane.mjs';
import {runCompiledSlimCommands} from './package-slim-lane.mjs';

/** Exact specs from the sanitized authorized active inventory; executable bytes
 * come exclusively from the verified compiled manifest/configuration asset. */
export const reviewedSetupFamilies=Object.freeze([
 ['ponytail','./node_modules/@dietrichgebert/ponytail/.opencode/plugins/ponytail.mjs',['devryan.ponytail']],
 ['cursor','./plugins/devryan-open-cursor.mjs',['devryan.provider-compat']],
 ['claude','./node_modules/opencode-with-claude/dist/index.js',['devryan.provider-compat']],
 ['superpowers','./plugins/devryan-superpowers.mjs',['devryan.reviewed-skills']],
 ['slim','./plugins/devryan-oh-my-opencode-slim.mjs',['devryan.slim','devryan.slim-commands','devryan.slim-lifecycle']],
 ['documents','./plugins/devryan-document-reader.mjs',['devryan.document-reader']],
 ['skills','./plugins/devryan-skill-context.mjs',['devryan.reviewed-skills']],
 ['imagegen','./node_modules/opencode-gpt-imagegen/dist/index.js',['opencode-gpt-imagegen']],
].map(([family,spec,origins])=>Object.freeze({family,spec,origins:Object.freeze(origins)})));
const browserSpec='./plugins/devryan-browser.mjs';
export function reviewedSetupRegistrations(origins,{browser=false}={}){
 const mapped=origins.map(origin=>({...origin,legacySpecs:[...reviewedSetupFamilies.filter(row=>row.origins.includes(origin.id)).map(row=>row.spec),
  ...browser&&origin.id==='devryan.browser'?[browserSpec]:[]]}));
 for(const row of reviewedSetupFamilies)for(const id of row.origins)assert.ok(mapped.some(origin=>origin.id===id),`Required compiled family unavailable: ${row.family}/${id}`);
 if(browser)assert.ok(mapped.some(origin=>origin.id==='devryan.browser'),'Required compiled browser unavailable');
 return mapped;
}

/** Original sealed Slim resolver, real snapshot capture/digest/validation. Only
 * route selections are fixture data; no installed configs/credentials are read. */
export function attachReviewedSetup({bundle,binding,registrationBytes,configuration,skillData,councilMembers,browser=false,remoteMcp}){
 const original=bundle.reviewedConfiguration;
 assert.equal(typeof original?.resolveSlimAgents,'function');assert.equal(typeof original?.ponytailCommands?.ponytail?.template,'string');
 const roles=['orchestrator','fixer','designer','council','oracle','explorer','librarian','builder'];
 const agents={...structuredClone(configuration.agents??{}),...Object.fromEntries(roles.map(name=>[name,{model:'devryan-smoke/smoke-write',variant:'default',mode:name==='orchestrator'||name==='builder'?'primary':'subagent'}]))};
 if(councilMembers!==undefined){
  assert.deepEqual(councilMembers,compiledCouncilMembers,'Only declared local Council diagnostic members are supported');
  agents.council.councillors=structuredClone(councilMembers);
 }
 // Slim/interview declarations belong to their actual SDK factories. Treating
 // them as saved commands suppresses the original execution-before behavior.
 const commands={...structuredClone(configuration.commands??{}),...original.ponytailCommands};
 const legacy={...structuredClone(configuration),agent:agents,command:commands,plugin:[...reviewedSetupFamilies.map(row=>row.spec),...browser?[browserSpec]:[]],default_agent:'orchestrator'};
 if(remoteMcp!==undefined)legacy.mcp=structuredClone(remoteMcp);
 // The full original tools/skills prompt exceeds the small baseline model.
 // Declare fixture capacity; native automatic compaction remains enabled.
 for(const id of ['smoke-write','gpt-5-native-smoke']){
  const model=legacy.providers?.['devryan-smoke']?.models?.[id];
  assert.ok(model?.limit,'Reviewed loopback model definition required');
  model.limit={...model.limit,input:131072,context:262144,output:4096};
 }
 delete legacy.agents;delete legacy.commands;
 const mergedConfig={agents:Object.fromEntries(roles.map(name=>[name,{model:'devryan-smoke/smoke-write',variant:'default'}])),disabled_mcps:['websearch','context7','grep_app']};
 // Both routes are the same owned loopback provider. Only the explicit 429
 // lane invokes the original saved-chain fallback behavior.
 mergedConfig.agents.orchestrator.model=['devryan-smoke/smoke-write','devryan-smoke/gpt-5-native-smoke'];
 mergedConfig.fallback={enabled:true,maxRetries:0,initialRetryDelayMs:0,retryDelayMs:0};
 const resolver=createNativeConfigurationSnapshotResolver({resolveSlimAgents:original.resolveSlimAgents,ponytailCommands:original.ponytailCommands,
  loadLocation:async({launch})=>({legacy:structuredClone(legacy),agents:structuredClone(agents),commands:structuredClone(commands),skills:skillData?packageSkillsForLaunch(skillData,launch):[],
   slim:{mergedConfig:structuredClone(mergedConfig)},parseMarkdown:parseMdFile})});
 bundle.resolveConfiguration=revision=>resolver({binding,revision,expectedRegistrationDigest:createHash('sha256').update(registrationBytes).digest('hex')});
 return {families:reviewedSetupFamilies,roles,personalProviderParity:false};
}

export async function assertReviewedSetupBoot({runtimeOwner,controller,client,onCase,browser=false}){
 const snapshot=runtimeOwner.getConfigurationSnapshot();assert.ok(snapshot?.locations.length);
 for(const location of snapshot.locations){
  for(const family of reviewedSetupFamilies)for(const id of family.origins)assert.ok(location.activeRegistrationIDs.includes(id),`Inactive required family: ${family.family}`);
  if(browser)assert.ok(location.activeRegistrationIDs.includes('devryan.browser'),'Inactive required browser facility');
  const commands=await client.catalog.commands({directory:location.directory});
  for(const name of ['deepwork','reflect','loop','interview','ponytail','ponytail-help'])assert.ok(commands.some(command=>command.name===name&&typeof command.template==='string'),`Missing original command ${name}`);
  assert.equal(location.compatibility.ponytail.defaultMode,'full');
 }
 assert.equal(controller.bound.catalog.asserted,true);
 const row={id:'compiled-reviewed-setup-active',status:'passed',families:reviewedSetupFamilies.map(row=>row.family),locations:snapshot.locations.length,
  source:'verified-sealed-original-slim-resolver-and-production-compiled-startup',personalProviderParity:false};onCase(row);return row;
}

/** Fixture enrolment precedes the real accepted prompt; it never creates a
 * primary record or substitutes a message/selection receipt. */
export async function createReviewedSetupSession({client,directory,input,admitPrimary}){
 assert.equal(typeof admitPrimary,'function','Reviewed root primary enrolment owner required');
 const session=await client.sessions.create(input,{directory});
 await admitPrimary(session.id);
 return session;
}

/** Actual command inference through the production adapter. Snapshot templates
 * and canonical persisted user content are the oracle; no hand-written prompt. */
export async function runReviewedSetupCommands({provider,client,runtimeOwner,directory,onCase,waitFor,admitPrimary,artifacts}){
 const session=await createReviewedSetupSession({client,directory,admitPrimary,input:{title:'Compiled original active commands',agent:'orchestrator',model:{providerID:'devryan-smoke',modelID:'smoke-write'}}});
 const snapshot=runtimeOwner.getConfigurationSnapshot().locations.find(row=>row.directory===directory);
 for(const command of ['ponytail-help']){
  const prepared=snapshot.configuration.commands[command];assert.equal(typeof prepared?.template,'string');let requests=0;
  const output=`compiled original ${command} completed`;
  await provider.setResponder(request=>{requests++;assert.equal(requests,1,'Original command duplicated inference');
   assert.ok(request.body.messages.some(message=>message.role==='user'),'Original command omitted its actual user input');
   return {items:[{type:'textDelta',text:output}],reason:'stop'};});
  await client.prompts.command(session.id,{command,arguments:'',agent:'orchestrator',model:{providerID:'devryan-smoke',modelID:'smoke-write'}},{directory,timeoutMs:30000});
  const page=await waitFor(()=>client.sessions.messages(session.id,{}, {directory}),page=>page.records.some(row=>row.info.role==='assistant'&&row.info.time?.completed&&row.parts.some(part=>part.type==='text'&&part.text===output)),`Original ${command} did not complete`);
  assert.equal(requests,1);const users=page.records.filter(row=>row.info.role==='user');assert.ok(users.length);
  const actual=users.at(-1).parts.filter(part=>part.type==='text').map(part=>part.text).join('\n');
  const expected=prepared.template.replace(/\$ARGUMENTS/g,'');assert.equal(actual,expected,'Original configured command bytes changed');
  onCase({id:`compiled-active-command-${command}`,status:'passed',sessionID:session.id,userMessageID:users.at(-1).info.id,
   templateSha256:createHash('sha256').update(prepared.template).digest('hex'),source:'actual-original-sealed-template-native-command-and-loopback-inference',personalProviderParity:false});
 }
 return runCompiledSlimCommands({provider,client,runtimeOwner,directory,onCase,waitFor,admitPrimary,artifacts});
}
