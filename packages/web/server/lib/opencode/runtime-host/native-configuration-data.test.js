import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseMdFile} from '../shared.js';
import {expect,it} from 'vitest';
import {NATIVE_PROVIDER_DEADLINES,nativeModelSelection,nativePermissionRules,translateNativeConfiguration} from './native-configuration-data.js';
import {PLAN_MODE_SYSTEM_INSTRUCTIONS} from '@devryan/orchestration-runtime';

it('captures planning format in visible primary prefixes and explicit native tool budgets', () => {
 const configuration=translateNativeConfiguration({legacy:{},agents:{orchestrator:{mode:'primary',prompt:'Own orchestration.'},
  builder:{mode:'primary',prompt:'Own implementation.'},explorer:{mode:'subagent',prompt:'Inspect.'},
  hidden:{mode:'primary',hidden:true,prompt:'Title helper.'},plan:{mode:'primary',prompt:'Plan owns its format.'}}});
 expect(configuration.tool_output).toEqual({max_bytes:51200,max_lines:1000});
 for(const name of ['orchestrator','builder']) expect(configuration.agents[name].system).toContain(PLAN_MODE_SYSTEM_INSTRUCTIONS);
 expect(configuration.agents.explorer.system).toBe('Inspect.');
 expect(configuration.agents.hidden.system).toBe('Title helper.');
 expect(configuration.agents.plan.system).toBe('Plan owns its format.');
 expect(translateNativeConfiguration({legacy:{tool_output:{max_bytes:10000}},agents:{}}).tool_output).toEqual({max_bytes:10000,max_lines:1000});
 expect(()=>translateNativeConfiguration({legacy:{tool_output:{max_lines:0}},agents:{}})).toThrow('native_tool_output_limits_invalid');
});
import {ConfigCompaction} from '@opencode/schema/config/compaction';
import {Schema} from 'effect';
it('preserves exact saved routes and native provider/model settings without running a transport',()=>{
 const legacy={provider:{'saved-route':{name:'Exact route',npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:1234/v1',timeout:false,headers:{'x-fixture':'exact'},body:{store:false}},models:{'model/key':{id:'upstream-model',name:'Saved model',tool_call:false,modalities:{input:['text'],output:['text']},options:{reasoningEffort:'high',custom:{keep:true}},variants:{medium:{reasoningEffort:'medium'},default:{custom:7}},cost:{input:1,output:2,cache_read:0.1,context_over_200k:{input:3,output:4,cache_write:0.2}},limit:{context:200000,output:10000}}}},'azure-cognitive-services':{models:{}},'google-vertex-anthropic':{models:{saved:{options:{thinking:{budget:1000}}}}}}};
 const before=structuredClone(legacy),config=translateNativeConfiguration({legacy,agents:{}});
 expect(legacy).toEqual(before);expect(Object.keys(config.providers)).toEqual(['saved-route','azure-cognitive-services','google-vertex-anthropic']);
 expect(config.providers['saved-route']).toMatchObject({package:'aisdk:@ai-sdk/openai-compatible',settings:{baseURL:'http://127.0.0.1:1234/v1',timeout:false},headers:{'x-fixture':'exact'},body:{store:false}});
 const model=config.providers['saved-route'].models['model/key'];
 expect(model).toMatchObject({modelID:'upstream-model',settings:{reasoningEffort:'high',custom:{keep:true}},capabilities:{tools:false,input:['text'],output:['text']},variants:[{id:'medium',settings:{reasoningEffort:'medium'}},{id:'default',settings:{custom:7}}]});
 expect(model.cost).toEqual([{input:1,output:2,cache:{read:0.1}},{input:3,output:4,cache:{write:0.2},tier:{type:'context',size:200000}}]);
 expect(config.providers['google-vertex-anthropic'].models.saved.package).toBe('aisdk:@ai-sdk/google-vertex/anthropic');
});
it('drops only the retired Meridian loopback proxy stanza DevRyan wrote',()=>{
 for(const baseURL of ['http://127.0.0.1:3456','http://localhost:3456/v1']){
  const {providers}=translateNativeConfiguration({legacy:{provider:{anthropic:{options:{apiKey:'dummy',baseURL}},zen:{}}},agents:{}});
  expect(Object.keys(providers)).toEqual(['zen']);
 }
 // A real Anthropic route, or a loopback route without the placeholder key, is kept.
 for(const options of [{apiKey:'dummy',baseURL:'https://api.anthropic.com/v1'},{apiKey:'dummy',baseURL:'http://127.0.0.1/v1'},{apiKey:'user-key',baseURL:'http://127.0.0.1:3456'}]){
  expect(Object.keys(translateNativeConfiguration({legacy:{provider:{anthropic:{options}}},agents:{}}).providers)).toEqual(['anthropic']);
 }
 // Only the `anthropic` id is the retired proxy.
 expect(Object.keys(translateNativeConfiguration({legacy:{provider:{custom:{options:{apiKey:'dummy',baseURL:'http://127.0.0.1:3456'}}}},agents:{}}).providers)).toEqual(['custom']);
});
it('maps saved Claude selections from every retired proxy provider id to claude-agent',()=>{
 for(const providerID of ['anthropic','claude','anthropic-oauth','opencode-with-claude']){
  expect(nativeModelSelection(`${providerID}/claude-opus-5`)).toEqual({providerID:'claude-agent',model:'claude-opus-5'});
  expect(nativeModelSelection({providerID,modelID:'claude-sonnet-5'},'high',true)).toEqual({providerID:'claude-agent',model:'claude-sonnet-5',variant:'high'});
 }
 expect(nativeModelSelection('claude-agent/claude-opus-5')).toEqual({providerID:'claude-agent',model:'claude-opus-5'});
 expect(nativeModelSelection('openai/gpt-5.6')).toEqual({providerID:'openai',model:'gpt-5.6'});
});
it('bounds every native provider stanza with header and chunk deadlines under saved values',()=>{
 expect(NATIVE_PROVIDER_DEADLINES).toEqual({headerTimeout:45000,chunkTimeout:300000});
 const legacy={provider:{zen:{},anthropic:{options:{baseURL:'http://127.0.0.1:3456'}},openai:{options:{baseURL:'https://api.openai.com/v1'}},
  tuned:{options:{headerTimeout:90000,chunkTimeout:600000,timeout:900000}},unbounded:{options:{headerTimeout:false,chunkTimeout:false}}}};
 const before=structuredClone(legacy),{providers}=translateNativeConfiguration({legacy,agents:{}});
 expect(legacy).toEqual(before);
 expect(providers.zen.settings).toEqual({headerTimeout:45000,chunkTimeout:300000});
 // Without the retired proxy's placeholder key, an anthropic stanza is an ordinary provider and gets the deadlines.
 expect(providers.anthropic.settings).toEqual({headerTimeout:45000,chunkTimeout:300000,baseURL:'http://127.0.0.1:3456'});
 // OpenAI reasoning may send nothing for minutes before its first output item.
 expect(providers.openai.settings).toEqual({headerTimeout:45000,chunkTimeout:300000,baseURL:'https://api.openai.com/v1'});
 expect(providers.tuned.settings).toEqual({headerTimeout:90000,chunkTimeout:600000,timeout:900000});
 expect(providers.unbounded.settings).toEqual({headerTimeout:false,chunkTimeout:false});
 const native=translateNativeConfiguration({legacy:{providers:{zen:{name:'Zen'},tuned:{settings:{chunkTimeout:60000}}}},agents:{}}).providers;
 expect(native).toEqual({zen:{name:'Zen',settings:{headerTimeout:45000,chunkTimeout:300000}},tuned:{settings:{headerTimeout:45000,chunkTimeout:60000}}});
 expect(()=>translateNativeConfiguration({legacy:{providers:{zen:{settings:'fast'}}},agents:{}})).toThrow('native_provider_invalid');
});
it('rejects malformed or conflicting provider definitions instead of silently dropping them',()=>{
 expect(()=>translateNativeConfiguration({legacy:{provider:[]},agents:{}})).toThrow('native_providers_invalid');
 expect(()=>translateNativeConfiguration({legacy:{provider:{a:{options:{headers:{invalid:1}}}}},agents:{}})).toThrow('native_provider_headers_invalid');
 expect(()=>translateNativeConfiguration({legacy:{provider:{},providers:{}},agents:{}})).toThrow('native_provider_shapes_conflict');
});
it('maps exact saved compaction budgets to the actual pinned native schema',()=>{
 const legacy={compaction:{auto:false,prune:false,preserve_recent_tokens:17000,reserved:9000}};
 const translated=translateNativeConfiguration({legacy,agents:{}}).compaction;
 expect(Schema.encodeSync(ConfigCompaction.Info)(Schema.decodeUnknownSync(ConfigCompaction.Info)(translated,{onExcessProperty:'error'}))).toEqual({auto:false,keep:{tokens:17000},buffer:9000});
 expect(legacy.compaction).toEqual({auto:false,prune:false,preserve_recent_tokens:17000,reserved:9000});
 expect(translateNativeConfiguration({legacy:{compaction:{keep:{tokens:0},buffer:0}},agents:{}}).compaction).toEqual({keep:{tokens:0},buffer:0});
 expect(()=>translateNativeConfiguration({legacy:{compaction:{reserved:1,buffer:2}},agents:{}})).toThrow('native_compaction_shapes_conflict');
 expect(()=>translateNativeConfiguration({legacy:{compaction:{keep:{tokens:-1}}},agents:{}})).toThrow();
 for(const buffer of [-1,1.5,Infinity,NaN]) {
  expect(()=>translateNativeConfiguration({legacy:{compaction:{buffer}},agents:{}})).toThrow();
  expect(()=>translateNativeConfiguration({legacy:{compaction:{reserved:buffer}},agents:{}})).toThrow();
 }
});
it('preserves explicit default/effort aliases against a known inherited model without guessing one',()=>{
 const legacy={model:'saved/global',variant:'high',default_agent:'builder'};
 const agents={builder:{model:'saved/role',variant:'medium'},inherited:{variant:null},omitted:{}};
 const commands={role:{agent:'builder',variant:'' ,template:'role'},global:{agent:'inherited',variant:'low',template:'global'},omitted:{template:'keep inheritance'}};
 const translated=translateNativeConfiguration({legacy,agents,commands});
 expect(translated.agents.inherited.model).toEqual({providerID:'saved',model:'global',variant:'default'});
 expect(translated.agents.omitted.model).toBeUndefined();
 expect(translated.commands.role.model).toEqual({providerID:'saved',model:'role',variant:'default'});
 expect(translated.commands.global.model).toEqual({providerID:'saved',model:'global',variant:'low'});
 expect(translated.commands.omitted.model).toBeUndefined();
 expect(()=>translateNativeConfiguration({legacy:{},agents:{unknown:{variant:'high'}}})).toThrow('native_variant_without_model');
 expect(()=>translateNativeConfiguration({legacy:{},agents:{},commands:{unknown:{variant:null,template:'unknown'}}})).toThrow('native_variant_without_model');
});

it('maps ordered legacy tool actions across strings, records and both array schemas',()=>{
 const rules=[{permission:'bash',pattern:'git *',action:'ask'},{permission:'task',pattern:'explorer',action:'allow'},
  {permission:'write',pattern:'*',action:'deny'},{permission:'patch',pattern:'*',action:'deny'},
  {permission:'edit',pattern:'*.md',action:'ask'},{permission:'apply_patch',pattern:'*',action:'deny'}];
 const expected=[{action:'shell',resource:'git *',effect:'ask'},{action:'subagent',resource:'explorer',effect:'allow'},
  {action:'edit',resource:'*',effect:'deny'},{action:'edit',resource:'*',effect:'deny'},
  {action:'edit',resource:'*.md',effect:'ask'},{action:'edit',resource:'*',effect:'deny'}];
 expect(nativePermissionRules(rules)).toEqual(expected);
 expect(nativePermissionRules(expected)).toEqual(expected);
 expect(nativePermissionRules({bash:{'*':'deny','git *':'ask'},task:{'*':'deny',explorer:'allow'},write:'deny',patch:'deny'}))
  .toEqual([{action:'shell',resource:'*',effect:'deny'},{action:'shell',resource:'git *',effect:'ask'},
   {action:'subagent',resource:'*',effect:'deny'},{action:'subagent',resource:'explorer',effect:'allow'},
   {action:'edit',resource:'*',effect:'deny'},{action:'edit',resource:'*',effect:'deny'}]);
 expect(nativePermissionRules('ask')).toEqual([{action:'*',resource:'*',effect:'ask'}]);
});
it('refuses conflicting aliases, malformed effects and competing permission shapes',()=>{
 for(const permission of [{write:'allow',patch:'deny'},{bash:'allow',shell:'ask'},
  [{action:'write',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'deny'}]]){
  expect(()=>nativePermissionRules(permission)).toThrow('native_permission_alias_conflict');
 }
 for(const permission of ['invalid',{bash:true},[{action:'shell',resource:'*',effect:'maybe'}],[{permission:'task',action:'allow'}]])
  expect(()=>nativePermissionRules(permission)).toThrow('native_permissions_invalid');
 expect(()=>translateNativeConfiguration({legacy:{permission:'deny',permissions:'allow'},agents:{}})).toThrow('native_permission_shapes_conflict');
 expect(()=>translateNativeConfiguration({legacy:{},agents:{a:{permission:'deny',permissions:'allow'}}})).toThrow('native_permission_shapes_conflict');
 expect(translateNativeConfiguration({legacy:{permissions:{bash:'deny'}},agents:{a:{permissions:{task:'ask'}}}})).toMatchObject({
  permissions:[{action:'shell',resource:'*',effect:'deny'}],agents:{a:{permissions:[{action:'subagent',resource:'*',effect:'ask'}]}}});
});

it('translates legacy boolean tools before explicit top-level permissions and pinned agent overrides',()=>{
 const configuration=translateNativeConfiguration({legacy:{tools:{bash:false,write:false,task:false},permission:{bash:{'git *':'allow'}}},
  agents:{reader:{tools:{write:false,patch:false,bash:false},permission:{edit:{'*.md':'allow'}}},native:{tools:{task:false},permissions:{subagent:'ask'}}}});
 expect(configuration.permissions).toEqual([{action:'shell',resource:'*',effect:'deny'},{action:'edit',resource:'*',effect:'deny'},
  {action:'subagent',resource:'*',effect:'deny'},{action:'shell',resource:'git *',effect:'allow'}]);
 expect(configuration.agents.reader.permissions).toEqual([{action:'edit',resource:'*.md',effect:'allow'},{action:'shell',resource:'*',effect:'deny'}]);
 expect(configuration.agents.native.permissions).toEqual([{action:'subagent',resource:'*',effect:'deny'},{action:'subagent',resource:'*',effect:'ask'}]);
 for(const tools of [null,[],{bash:'false'},{bash:0}]){
  for(const scope of [{legacy:{tools},agents:{}},{legacy:{},agents:{reader:{tools}}}])
   expect(()=>translateNativeConfiguration(scope)).toThrow('native_legacy_tools_invalid');
 }
 expect(()=>translateNativeConfiguration({legacy:{tools:{bash:false,shell:true}},agents:{}})).toThrow('native_permission_alias_conflict');
 expect(()=>translateNativeConfiguration({legacy:{},agents:{reader:{tools:{write:false,patch:true}}}})).toThrow('native_legacy_tools_alias_conflict');
});

it('preserves the packaged Explorer/Librarian shell and delegation denies in native configuration',()=>{
 const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../default-config/agents');
 const agents=Object.fromEntries(['explorer','librarian','builder','orchestrator','plan'].map(name=>[name,parseMdFile(path.join(directory,`${name}.md`)).frontmatter]));
 const configuration=translateNativeConfiguration({legacy:{},agents});
 for(const name of ['explorer','librarian']){
  expect(configuration.agents[name].permissions).toContainEqual({action:'shell',resource:'*',effect:'deny'});
  expect(configuration.agents[name].permissions).toContainEqual({action:'subagent',resource:'*',effect:'deny'});
  expect(configuration.agents[name].permissions).toContainEqual({action:'edit',resource:'*',effect:'deny'});
 }
 expect(configuration.agents.builder.permissions.filter(rule=>rule.action==='subagent')).toEqual(
  Object.entries(agents.builder.permission.task).map(([resource,effect])=>({action:'subagent',resource,effect})));
 expect(configuration.agents.plan.permissions.filter(rule=>rule.action==='edit')).toEqual(
  Object.entries(agents.plan.permission.edit).map(([resource,effect])=>({action:'edit',resource,effect})));
});

import {Config as NativeConfigSchema} from '@opencode/schema/config';
import {Duration} from 'effect';
import {NATIVE_LOCATION_IDLE_TIMEOUT} from './native-configuration-data.js';
it('releases idle locations after the reviewed native idle timeout, decoded by the native schema',()=>{
 const configuration=translateNativeConfiguration({legacy:{},agents:{}});
 expect(configuration.experimental).toEqual({location_idle_timeout:NATIVE_LOCATION_IDLE_TIMEOUT});
 const info=Schema.decodeUnknownSync(NativeConfigSchema.Info)(configuration,{onExcessProperty:'error'});
 const timeout=info.experimental?.location_idle_timeout;
 expect(timeout===false||timeout===undefined?null:Duration.toMillis(timeout)).toBe(15*60*1000);
});

it('enables background compaction only through DEVRYAN_BACKGROUND_COMPACTION=1, and never native todo',()=>{
 for(const value of [undefined,'0','true','']) {
   const configuration=translateNativeConfiguration({legacy:{},agents:{},environment:{DEVRYAN_BACKGROUND_COMPACTION:value}});
   expect(configuration.experimental).toEqual({location_idle_timeout:NATIVE_LOCATION_IDLE_TIMEOUT});
 }
 const enabled=translateNativeConfiguration({legacy:{},agents:{},environment:{DEVRYAN_BACKGROUND_COMPACTION:'1'}});
 expect(enabled.experimental).toEqual({location_idle_timeout:NATIVE_LOCATION_IDLE_TIMEOUT,background_compaction:true});
 const info=Schema.decodeUnknownSync(NativeConfigSchema.Info)(enabled,{onExcessProperty:'error'});
 expect(info.experimental?.background_compaction).toBe(true);
 expect(info.experimental?.todo).toBeUndefined();
});

it('carries packaged specialist step caps into native agent info, decoded by the native schema',()=>{
 const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../default-config/agents');
 const names=['explorer','librarian','fixer','designer'];
 const agents=Object.fromEntries(names.map(name=>[name,parseMdFile(path.join(directory,`${name}.md`)).frontmatter]));
 const configuration=translateNativeConfiguration({legacy:{},agents});
 const info=Schema.decodeUnknownSync(NativeConfigSchema.Info)(configuration,{onExcessProperty:'error'});
 expect(Object.fromEntries(names.map(name=>[name,info.agents?.[name]?.steps]))).toEqual({explorer:35,librarian:35,fixer:120,designer:120});
});
