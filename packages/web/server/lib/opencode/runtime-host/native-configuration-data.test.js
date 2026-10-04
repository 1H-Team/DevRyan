import {expect,it} from 'vitest';
import {translateNativeConfiguration} from './native-configuration-data.js';
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
