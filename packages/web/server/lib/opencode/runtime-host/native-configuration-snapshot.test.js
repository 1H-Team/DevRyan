import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createNativeConfigurationSnapshotResolver, nativeCatalogModels, nativeCatalogSelections } from './native-configuration-snapshot.js';
import { readReviewedSkillResource, resolveReviewedSkillAlias, lookupReviewedSkillResourcePath } from './reviewed-skills.js';

const roots = [];

it('requires exact effective selections, command efforts and ordered Council/fallback routes without substitution',()=>{
 const council=[{model:'xai/grok-4.6',variant:'high'},{model:'openai/gpt-6.1-sol',variant:null}];
 const compatibility={agents:{council:{councillors:council}},slim:{nativeRuntime:{runtimeChains:{builder:['openai/gpt-6-astra','openai/gpt-6.1-sol']},modelArrays:{builder:[{id:'openai/gpt-6-astra',variant:'medium'},{id:'openai/gpt-6.1-sol',variant:'high'}]}}}};
 const configuration={model:{providerID:'openai',model:'gpt-6-astra',variant:'low'},agents:{builder:{model:{providerID:'openai',model:'gpt-6-astra',variant:'high'}},disabled:{disabled:true,model:{providerID:'unavailable',model:'ignored'}}},commands:{check:{model:{providerID:'openai',model:'gpt-6-astra',variant:'medium'}}}};
 expect(nativeCatalogModels(configuration,compatibility)).toEqual([
  {providerID:'openai',id:'gpt-6-astra',variant:'low'}, {providerID:'openai',id:'gpt-6-astra',variant:'high'},
  {providerID:'openai',id:'gpt-6-astra',variant:'medium'}, {providerID:'xai',id:'grok-4.6',variant:'high'},
  {providerID:'openai',id:'gpt-6.1-sol',variant:'default'}, {providerID:'openai',id:'gpt-6-astra',variant:'default'},
  {providerID:'openai',id:'gpt-6.1-sol',variant:'high'},
 ]);
 expect(compatibility.agents.council.councillors).toBe(council);
});
it('requires actual enabled role backups without admitting a disabled role backup',()=>{
 const configuration={agents:{builder:{model:{providerID:'openai',model:'gpt-6-astra'}},disabled:{disabled:true}}};
 const compatibility={agents:{builder:{backupModel:{providerID:'xai',modelID:'grok-4.6',variant:'high'}},disabled:{backupModel:{providerID:'missing',modelID:'ignored',variant:null}}}};
 expect(nativeCatalogModels(configuration,compatibility)).toEqual([
  {providerID:'openai',id:'gpt-6-astra',variant:'default'},
  {providerID:'xai',id:'grok-4.6',variant:'high'},
 ]);
});
it('keeps disabled Council member routes dormant',()=>{
 const compatibility={agents:{council:{councillors:[{model:'missing/dormant',variant:'high'}]}}};
 expect(nativeCatalogModels({agents:{council:{disabled:true}}},compatibility)).toEqual([]);
});
it('attributes duplicate unavailable tuples to every saved role, backup, command and Council seat', () => {
 const ref={providerID:'cursor-acp',model:'composer-2.5',variant:'high'};
 const configuration={model:ref,agents:{builder:{model:ref}},commands:{review:{model:ref}}};
 const compatibility={agents:{builder:{backupModel:{providerID:'cursor-acp',modelID:'composer-2.5',variant:'high'}},
  council:{councillors:[{model:'cursor-acp/composer-2.5',variant:'high'},{model:'cursor-acp/composer-2.5',variant:'high'}]}}};
 const selections=nativeCatalogSelections(configuration,compatibility);
 expect(selections.map(row=>row.source)).toEqual([{kind:'model'},{kind:'agent',id:'builder'},{kind:'backup',id:'builder'},
  {kind:'command',id:'review'},{kind:'councillor',id:'council',index:0},{kind:'councillor',id:'council',index:1}]);
 expect(selections.every(row=>row.providerID==='cursor-acp'&&row.modelID==='composer-2.5'&&row.variant==='high')).toBe(true);
 expect(nativeCatalogModels(configuration,compatibility)).toEqual([{providerID:'cursor-acp',id:'composer-2.5',variant:'high'}]);
 expect(compatibility.agents.council.councillors.map(row=>row.variant)).toEqual(['high','high']);
});

afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-settings-'))); roots.push(root);
  const directory = path.join(root, 'project'), config = path.join(root, 'config'), home = path.join(root, 'home');
  for (const folder of [directory, config, home]) await fs.mkdir(folder);
  const skillRoot = path.join(config, 'skills', 'fixture'); await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), 'exact skill body\n');
  await fs.writeFile(path.join(skillRoot, 'support.txt'), 'exact asset\n');
  const manifest = JSON.stringify({ schema: 1, plugins: [{ id: 'devryan.fixture', legacySpecs: ['./plugins/fixture.mjs'] }] });
  const reviewedPluginManifestPath = path.join(root, 'plugins.json'), reviewedNativeConfigPath = path.join(root, 'policy.json');
  await fs.writeFile(reviewedPluginManifestPath, manifest);
  await fs.writeFile(reviewedNativeConfigPath, JSON.stringify({ schema: 1, configuration: {}, locations: [{ directory }],
    catalogRequirements: { agents: [], plugins: ['devryan.fixture'], tools: [], models: [] } }));
  const loaded = { legacy: { plugin: ['./plugins/fixture.mjs'], mcp: { active: { enabled: true }, dormant: { enabled: false } } },
    agents: { builder: { model: 'openai/model', variant: null, prompt: 'saved prompt\n', options: { custom: 7 }, permission: { edit: { '*': 'ask', '*.md': 'allow' } } } },
    commands: { fixture: { template: 'exact command\n', model: 'openai/model', variant: 'medium' } },
    skills: [{ name: 'fixture', path: path.join(skillRoot, 'SKILL.md'), source: 'opencode' }], slim: { agents: { builder: { variant: null } } },
    parseMarkdown: file => ({ body: file.endsWith('SKILL.md') ? 'exact skill body\n' : '', frontmatter: {} }) };
  // The loader is constructor-owned, not request data or authority metadata.
  const resolver = createNativeConfigurationSnapshotResolver({ loadLocation: async () => ({ ...structuredClone({ ...loaded, parseMarkdown: undefined }), parseMarkdown: loaded.parseMarkdown }) });
  return { root, directory, skillRoot, loaded, resolver, input: { binding: { descriptor: { generation: 2,
    launch: { opencodeConfigDirectory: config, global: { home }, reviewedPluginManifestPath, reviewedNativeConfigPath },
    projectMap: [{ targetDirectory: directory }] } }, revision: 1, expectedRegistrationDigest: createHash('sha256').update(manifest).digest('hex') } };
}

it('freezes exact effective roles, ordered rules, commands, resources and disabled MCP definitions', async () => {
  const f = await fixture(), first = await f.resolver(f.input), again = await f.resolver(f.input);
  expect(first.digest).toBe(again.digest); expect(Object.isFrozen(first.locations[0].compatibility.agents)).toBe(true);
  expect(first.locations[0].configuration.agents.builder).toMatchObject({ model: { providerID: 'openai', model: 'model', variant: 'default' }, system: 'saved prompt\n', request: { body: { custom: 7 } } });
  expect(first.locations[0].configuration.agents.builder.permissions).toEqual([{ action: 'edit', resource: '*', effect: 'ask' }, { action: 'edit', resource: '*.md', effect: 'allow' }]);
  expect(first.locations[0].configuration.commands.fixture.template).toBe('exact command\n');
  expect(first.locations[0].requiredCatalogs.mcp).toEqual(['active']);
  expect(first.locations[0].requiredCatalogs.models).toEqual([
    { providerID: 'openai', id: 'model', variant: 'default' },
    { providerID: 'openai', id: 'model', variant: 'medium' },
  ]);
  expect(first.locations[0].compatibility.mcp.dormant).toEqual({ enabled: false });
  const skill = first.locations[0].skills[0]; expect(skill.content).toBe('exact skill body\n');
  expect(await readReviewedSkillResource(first, { snapshotDigest: first.digest, directory: f.directory, skillID: skill.id, relativePath: 'support.txt' })).toEqual(Buffer.from('exact asset\n'));
  f.loaded.agents.builder.variant = 'high';
  const changed = await f.resolver({ ...f.input, revision: 2 });
  expect(changed.digest).not.toBe(first.digest); expect(first.locations[0].configuration.agents.builder.model.variant).toBe('default');
});

it('derives enabled native agents while preserving every explicit catalog requirement',async()=>{
 const f=await fixture();
 f.loaded.agents.title={disabled:true};
 f.loaded.agents.legacyDormant={disable:true};
 f.loaded.agents.enabled={disable:true,disabled:false};
 const snapshot=await f.resolver(f.input),location=snapshot.locations[0];
 expect(location.configuration.agents.title.disabled).toBe(true);
 expect(location.configuration.agents.legacyDormant.disabled).toBe(true);
 expect(location.configuration.agents.enabled.disabled).toBe(false);
 expect(location.requiredCatalogs.agents).toEqual(['builder','enabled']);
 const file=f.input.binding.descriptor.launch.reviewedNativeConfigPath;
 const policy=JSON.parse(await fs.readFile(file,'utf8'));
 policy.catalogRequirements.agents=['title','explicit-missing','builder'];
 await fs.writeFile(file,JSON.stringify(policy));
 const explicitlyRequired=await f.resolver({...f.input,revision:2});
 expect(explicitlyRequired.locations[0].requiredCatalogs.agents).toEqual(['title','explicit-missing','builder','enabled']);
});

it('derives enabled agents when the reviewed policy omits its agent list',async()=>{
 const f=await fixture();
 f.loaded.agents.title={disabled:true};
 const file=f.input.binding.descriptor.launch.reviewedNativeConfigPath;
 const policy=JSON.parse(await fs.readFile(file,'utf8'));
 policy.catalogRequirements={};
 await fs.writeFile(file,JSON.stringify(policy));
 const snapshot=await f.resolver(f.input);
 expect(snapshot.locations[0].requiredCatalogs.agents).toEqual(['builder']);
 expect(snapshot.locations[0].configuration.agents.title.disabled).toBe(true);
});

it('refuses malformed explicit agent requirements instead of dropping them',async()=>{
 const f=await fixture();
 const file=f.input.binding.descriptor.launch.reviewedNativeConfigPath;
 const policy=JSON.parse(await fs.readFile(file,'utf8'));
 for(const agents of [null,'builder',42,{},['builder',null],['']]){
  policy.catalogRequirements.agents=agents;
  await fs.writeFile(file,JSON.stringify(policy));
  await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_snapshot_policy_invalid'});
 }
});

it('derives separate model requirements from each effective project configuration',async()=>{
 const f=await fixture(),other=path.join(f.root,'project-b');await fs.mkdir(other);
 const policyPath=f.input.binding.descriptor.launch.reviewedNativeConfigPath;
 const policy=JSON.parse(await fs.readFile(policyPath,'utf8'));policy.locations.push({directory:other});await fs.writeFile(policyPath,JSON.stringify(policy));
 f.input.binding.descriptor.projectMap.push({targetDirectory:other});
 const resolver=createNativeConfigurationSnapshotResolver({loadLocation:async({directory})=>({
  ...f.loaded,agents:{builder:{model:directory===other?'xai/grok-4.6':'openai/gpt-6.1-sol',variant:directory===other?null:'high'}},commands:{},skills:[],
 })});
 const snapshot=await resolver(f.input);
 expect(snapshot.locations.map(location=>location.requiredCatalogs.models)).toEqual([
  [{providerID:'openai',id:'gpt-6.1-sol',variant:'high'}],
  [{providerID:'xai',id:'grok-4.6',variant:'default'}],
 ]);
});

it('captures active local configured skill data below selected node_modules with coherent resource stamps',async()=>{
 const f=await fixture(),config=f.input.binding.descriptor.launch.opencodeConfigDirectory;
 const folder=path.join(config,'node_modules','@dietrichgebert','ponytail','skills','ponytail');
 await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'SKILL.md'),'configured body\n');await fs.writeFile(path.join(folder,'reference.txt'),'support v1');
 f.loaded.legacy.skills={paths:[path.dirname(folder)],urls:[]};
 f.loaded.parseMarkdown=file=>({body:file.startsWith(folder)?'configured body\n':'exact skill body\n',frontmatter:file.startsWith(folder)?{name:'ponytail'}:{}});
 const first=await f.resolver(f.input),skill=first.locations[0].skills.find(value=>value.name==='ponytail');
 expect(skill.path).toBe(path.join(folder,'SKILL.md'));expect(skill.content).toBe('configured body\n');
 expect(await readReviewedSkillResource(first,{snapshotDigest:first.digest,directory:f.directory,skillID:skill.id,relativePath:'reference.txt'})).toEqual(Buffer.from('support v1'));
 await fs.writeFile(path.join(folder,'reference.txt'),'support v2');
 const next=await f.resolver({...f.input,revision:2});expect(next.sourceStamp).not.toBe(first.sourceStamp);
 await expect(readReviewedSkillResource(first,{snapshotDigest:first.digest,directory:f.directory,skillID:skill.id,relativePath:'reference.txt'})).rejects.toMatchObject({code:'native_skill_resource_changed'});
 f.loaded.legacy.skills={paths:[],urls:['https://fixture.invalid/skills']};
 await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_skill_remote_source_unqualified'});
 f.loaded.legacy.skills={paths:[path.dirname(f.root)],urls:[]};
 await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_skill_source_unreviewed'});
});

it('rejects registration changes, unreviewed mutable plugins and escaped skill assets', async () => {
  const f = await fixture();
  await expect(f.resolver({ ...f.input, expectedRegistrationDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'native_registration_revision_mismatch' });
  f.loaded.legacy.plugin.push('./plugins/unknown.mjs');
  await expect(f.resolver(f.input)).rejects.toMatchObject({ code: 'native_plugin_registration_unreviewed' });
  f.loaded.legacy.plugin.pop(); await fs.symlink(path.join(f.root, 'policy.json'), path.join(f.skillRoot, 'escape'));
  await expect(f.resolver(f.input)).rejects.toMatchObject({ code: 'native_skill_resource_escape' });
});

it('ignores retired DevRyan plugin registrations that an upgraded setup still lists', async () => {
  const f = await fixture(), baseline = await f.resolver(f.input);
  // DevRyan <= 2.0.1 provisioned the Superpowers adapter into every profile;
  // the seeded native setup keeps that registration after its removal.
  f.loaded.legacy.plugin.push('./plugins/devryan-superpowers.mjs', 'superpowers@git+https://github.com/obra/superpowers.git');
  const upgraded = await f.resolver(f.input);
  expect(upgraded.locations[0].activePlugins).toEqual(baseline.locations[0].activePlugins);
  expect(upgraded.locations[0].activeRegistrationIDs).toEqual(baseline.locations[0].activeRegistrationIDs);
  expect(upgraded.locations[0].requiredCatalogs.plugins).toEqual(['devryan.fixture']);
  f.loaded.legacy.plugin.push('./plugins/unknown.mjs');
  await expect(f.resolver(f.input)).rejects.toMatchObject({ code: 'native_plugin_registration_unreviewed' });
});

it('rejects changed resource bytes, stale snapshots and name ambiguity without dropping duplicate skills', async () => {
  const f = await fixture(), other = path.join(f.directory, '.agents', 'skills', 'fixture'); await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, 'SKILL.md'), 'exact skill body\n');
  f.loaded.skills.push({ name: 'fixture', path: path.join(other, 'SKILL.md'), source: 'agents' });
  const snapshot = await f.resolver(f.input); expect(snapshot.locations[0].skills).toHaveLength(2); expect(snapshot.locations[0].aliases).toEqual([]);
  const input = { snapshotDigest: snapshot.digest, directory: f.directory, skillID: snapshot.locations[0].skills[0].id, relativePath: 'support.txt' };
  await expect(readReviewedSkillResource(snapshot, { ...input, snapshotDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'native_skill_resource_unreviewed' });
  await fs.writeFile(path.join(f.skillRoot, 'support.txt'), 'tampered___\n');
  await expect(readReviewedSkillResource(snapshot, input)).rejects.toMatchObject({ code: 'native_skill_resource_changed' });
});

it('preserves names, directory aliases, normalized keys and unambiguous prefixes with stable-ID duplicate disambiguation', async () => {
  const f=await fixture();f.loaded.skills[0].name='Accessibility (a11y)';
  const snapshot=await f.resolver(f.input),first=snapshot.locations[0].skills[0];
  for(const requested of ['Accessibility (a11y)','ACCESSIBILITY-A11Y','accessibility','fixture',first.id]) {
    expect(resolveReviewedSkillAlias(snapshot,f.directory,requested)).toBe(first.id);
  }
  const other=path.join(f.directory,'.agents','skills','project-a11y');await fs.mkdir(other,{recursive:true});await fs.writeFile(path.join(other,'SKILL.md'),'exact skill body\n');
  f.loaded.skills.push({name:'Accessibility (a11y)',path:path.join(other,'SKILL.md'),source:'agents'});
  const duplicate=await f.resolver({...f.input,revision:2}),second=duplicate.locations[0].skills[1];
  expect(resolveReviewedSkillAlias(duplicate,f.directory,'Accessibility (a11y)')).toBeNull();
  expect(resolveReviewedSkillAlias(duplicate,f.directory,'accessibility')).toBeNull();
  expect(resolveReviewedSkillAlias(duplicate,f.directory,'fixture')).toBe(first.id);
  expect(resolveReviewedSkillAlias(duplicate,f.directory,'project-a11y')).toBe(second.id);
  expect(resolveReviewedSkillAlias(duplicate,f.directory,first.id)).toBe(first.id);
  expect(resolveReviewedSkillAlias(duplicate,'unreviewed',first.id)).toBeNull();
});

it('retries the entire snapshot when settings change during capture and refuses continuously changing sources',async()=>{
 const f=await fixture(),file=path.join(f.root,'config','settings.json');await fs.writeFile(file,'old');let reads=0;
 const loader=async()=>{reads++;if(reads===1)await fs.writeFile(file,'changed');return {...f.loaded,agents:{builder:{model:'sim/m1',variant:'high',prompt:'revision-'+reads}}};};
 const result=await createNativeConfigurationSnapshotResolver({loadLocation:loader})(f.input);
 expect(reads).toBe(2);expect(result.locations[0].configuration.agents.builder.system).toBe('revision-2');expect(result.sourceStamp).toMatch(/^[a-f0-9]{64}$/);
 let changes=0;const unstable=async()=>{await fs.writeFile(file,'changing-'+ ++changes);return f.loaded;};
 await expect(createNativeConfigurationSnapshotResolver({loadLocation:unstable})(f.input)).rejects.toMatchObject({code:'native_configuration_sources_changed'});
 expect(changes).toBe(3);
});

it('captures exact prompt/command reference bytes and explicit instruction data without enabling native discovery',async()=>{
 const f=await fixture(),prompt=path.join(f.root,'config','prompt.txt');await fs.writeFile(prompt,'exact referenced prompt\n');
 f.loaded.agents.builder.prompt='{file:./prompt.txt}';f.loaded.commands.fixture.template='{file:prompt.txt}';f.loaded.legacy.instructions=[prompt];
 const snapshot=await f.resolver(f.input),location=snapshot.locations[0];
 expect(location.configuration.agents.builder.system).toBe('exact referenced prompt\n');expect(location.configuration.commands.fixture.template).toBe('exact referenced prompt\n');
 expect(location.compatibility.agents.builder.prompt).toBe('{file:./prompt.txt}');expect(location.instructions[0].content).toBe('exact referenced prompt\n');expect(location.configuration.instructions).toBeUndefined();
 f.loaded.legacy.instructions=['**/rules.md'];await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_instruction_source_unqualified'});
 f.loaded.legacy.instructions=[];await fs.mkdir(path.join(f.root,'config','.git'));await fs.writeFile(path.join(f.root,'config','.git','config'),'protected');f.loaded.agents.builder.prompt='{file:.git/config}';
 await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_text_source_unreviewed'});
});

it('grants only exact reviewed main/support file paths with current bytes and location identity',async()=>{
 const f=await fixture(),snapshot=await f.resolver(f.input),skill=snapshot.locations[0].skills[0];
 const main=lookupReviewedSkillResourcePath(snapshot,{snapshotDigest:snapshot.digest,directory:f.directory,targetPath:skill.path});
 expect(main).toMatchObject({skillID:skill.id,relativePath:'SKILL.md'});expect(await readReviewedSkillResource(snapshot,main)).toEqual(Buffer.from('exact skill body\n'));
 const support=lookupReviewedSkillResourcePath(snapshot,{snapshotDigest:snapshot.digest,directory:f.directory,targetPath:path.join(f.skillRoot,'support.txt')});
 expect(await readReviewedSkillResource(snapshot,support)).toEqual(Buffer.from('exact asset\n'));
 for(const targetPath of [path.join(f.skillRoot,'missing.txt'),path.join(f.root,'config','settings.json'),path.join(f.skillRoot,'.git','config')])expect(lookupReviewedSkillResourcePath(snapshot,{snapshotDigest:snapshot.digest,directory:f.directory,targetPath})).toBeNull();
 expect(lookupReviewedSkillResourcePath(snapshot,{snapshotDigest:'0'.repeat(64),directory:f.directory,targetPath:skill.path})).toBeNull();
 expect(lookupReviewedSkillResourcePath(snapshot,{snapshotDigest:snapshot.digest,directory:'other',targetPath:skill.path})).toBeNull();
 await fs.unlink(skill.path);await fs.symlink(path.join(f.skillRoot,'support.txt'),skill.path);
 await expect(readReviewedSkillResource(snapshot,main)).rejects.toMatchObject({code:'native_skill_resource_changed'});
});

it('preserves ordered skill effects via stable IDs and actual native wildcard rules',async()=>{
 const f=await fixture();f.loaded.skills[0].name='Fixture Skill';f.loaded.agents.builder.permission.skill={'*':'deny','fixture':'allow','Fixture?Skill':'ask'};
 const snapshot=await f.resolver(f.input),id=snapshot.locations[0].skills[0].id,rules=snapshot.locations[0].configuration.agents.builder.permissions.filter(rule=>rule.action==='skill');
 expect(rules).toEqual([{action:'skill',resource:'*',effect:'deny'},{action:'skill',resource:id,effect:'allow'},{action:'skill',resource:id,effect:'ask'}]);
 f.loaded.agents.builder.permission.skill={'*':'deny','devryan-*':'allow'};
 await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_skill_permission_pattern_unqualified'});
 const other=path.join(f.directory,'.agents','skills','fixture');await fs.mkdir(other,{recursive:true});await fs.writeFile(path.join(other,'SKILL.md'),'exact skill body\n');
 f.loaded.skills.push({name:'Fixture Skill',path:path.join(other,'SKILL.md'),source:'agents'});f.loaded.agents.builder.permission.skill={'Fixture Skill':'allow'};
 await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_skill_permission_ambiguous'});
});

it('captures original Slim prompt inputs before the shared snapshot digest and refuses a missing compiled resolver',async()=>{
 const f=await fixture(),launch=f.input.binding.descriptor.launch;
 const manifest=JSON.stringify({schema:1,plugins:[{id:'devryan.slim',legacySpecs:['oh-my-opencode-slim@2.2.25']}]});
 await fs.writeFile(launch.reviewedPluginManifestPath,manifest);f.input.expectedRegistrationDigest=createHash('sha256').update(manifest).digest('hex');
 f.loaded.legacy.plugin=['oh-my-opencode-slim@2.2.25'];f.loaded.slim={mergedConfig:{preset:'saved',agents:{builder:{model:'openai/model'}}},activePreset:'saved'};
 await fs.mkdir(path.join(f.directory,'.opencode','prompts','saved'),{recursive:true});await fs.mkdir(path.join(launch.opencodeConfigDirectory,'prompts'),{recursive:true});
 await fs.writeFile(path.join(f.directory,'.opencode','prompts','saved','builder.md'),'EXACT PROJECT PROMPT\n');
 await fs.writeFile(path.join(launch.opencodeConfigDirectory,'prompts','builder.md'),'USER PROMPT\n');await fs.writeFile(path.join(launch.opencodeConfigDirectory,'prompts','builder_append.md'),'EXACT USER APPEND\n');
 await expect(f.resolver(f.input)).rejects.toMatchObject({code:'native_slim_configuration_owner_required'});
 let captured;const resolver=createNativeConfigurationSnapshotResolver({loadLocation:async()=>({...structuredClone({...f.loaded,parseMarkdown:undefined}),parseMarkdown:f.loaded.parseMarkdown}),resolveSlimAgents:input=>{
  captured=input;return {agents:{...input.hostConfiguration.agent,builtin:{model:'openai/model',prompt:'ORIGINAL BUILTIN PROMPT\n'}},defaultAgent:'builder',backgroundJobs:{strategy:'checkpoint-compatible',maxRetainedSnapshots:2,readContextMaxFiles:3}};
 }});
 const first=await resolver(f.input);expect(first.locations[0].compatibility.slim.nativeRuntime.backgroundJobs).toEqual({strategy:'checkpoint-compatible',maxRetainedSnapshots:2,readContextMaxFiles:3});expect(captured.prompts.builder).toEqual({prompt:'EXACT PROJECT PROMPT\n',appendPrompt:'EXACT USER APPEND\n'});
 expect(captured.hostConfiguration.agent.builder.prompt).toBe('saved prompt\n');expect(captured.localSkills).toEqual(['fixture']);
 expect(first.locations[0].configuration.agents.builtin.system).toBe('ORIGINAL BUILTIN PROMPT\n');expect(first.locations[0].compatibility.agents.builtin.prompt).toBe('ORIGINAL BUILTIN PROMPT\n');
 expect(first.locations[0].textReferences.map(value=>value.content)).toEqual(['EXACT PROJECT PROMPT\n','EXACT USER APPEND\n']);
 await fs.writeFile(path.join(launch.opencodeConfigDirectory,'prompts','builder_append.md'),'CHANGED APPEND\n');
 const second=await resolver({...f.input,revision:2});expect(second.digest).not.toBe(first.digest);expect(captured.prompts.builder.appendPrompt).toBe('CHANGED APPEND\n');
});

it('uses exact per-location active registrations and original Ponytail command overwrite precedence',async()=>{
 const f=await fixture(),launch=f.input.binding.descriptor.launch;
 const manifest=JSON.stringify({schema:1,plugins:[{id:'devryan.ponytail',legacySpecs:['@dietrichgebert/ponytail']},{id:'devryan.slim',legacySpecs:['oh-my-opencode-slim@2.2.25']}]});
 await fs.writeFile(launch.reviewedPluginManifestPath,manifest);f.input.expectedRegistrationDigest=createHash('sha256').update(manifest).digest('hex');f.loaded.legacy.plugin=['@dietrichgebert/ponytail'];f.loaded.commands.ponytail={template:'saved override'};
 const {renderReviewedPonytailInstructions}=await import('./reviewed-ponytail-instructions.js'),{commands}=await renderReviewedPonytailInstructions();
 const loadLocation=async()=>({...structuredClone({...f.loaded,parseMarkdown:undefined}),parseMarkdown:f.loaded.parseMarkdown});
 await expect(createNativeConfigurationSnapshotResolver({loadLocation})(f.input)).rejects.toMatchObject({code:'native_ponytail_commands_owner_required'});
 const result=await createNativeConfigurationSnapshotResolver({loadLocation,ponytailCommands:commands,ponytailDefaultMode:'LITE'})(f.input);
 expect(result.locations[0].activeRegistrationIDs).toEqual(['devryan.ponytail']);expect(result.locations[0].requiredCatalogs.plugins).toEqual(['devryan.ponytail']);expect(result.locations[0].configuration.commands.ponytail.template).toBe(commands.ponytail.template);
 expect(result.locations[0].compatibility.commands.ponytail).toEqual(commands.ponytail);expect(result.locations[0].compatibility.ponytail.defaultMode).toBe('lite');
});

it('uses only constructor-owned canonical registered locations and seals their fresh settings',async()=>{
 const f=await fixture(),second=path.join(f.root,'second');await fs.mkdir(second);
 const {createNativeProjectLocations}=await import('./native-project-locations.js');
 const derive=createNativeProjectLocations({baseLocations:[{directory:f.directory}],launch:{...f.input.binding.descriptor.launch,
  webDataDirectory:path.join(f.root,'private-data'),webConfigDirectory:path.join(f.root,'private-config'),global:{...f.input.binding.descriptor.launch.global,tmp:path.join(f.root,'private-tmp')}},getRegisteredProjects:async()=>[{path:second}]});
 const resolver=createNativeConfigurationSnapshotResolver({getRuntimeLocations:derive,loadLocation:async()=>({...structuredClone({...f.loaded,parseMarkdown:undefined}),parseMarkdown:f.loaded.parseMarkdown})});
 const snapshot=await resolver(f.input);expect(snapshot.locations.map(location=>location.directory)).toEqual([f.directory,second]);
 expect(snapshot.locations[1].configuration.agents.builder.model).toEqual(snapshot.locations[0].configuration.agents.builder.model);
 expect((await f.resolver({...f.input,runtimeLocations:[{directory:second}]})).locations.map(location=>location.directory)).toEqual([f.directory]);
});
