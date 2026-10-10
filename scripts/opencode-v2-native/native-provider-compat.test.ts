import {expect,test,spyOn} from 'bun:test';
import {Model} from '@opencode/core/model';
import {Provider} from '@opencode/core/provider';
import {Schema} from 'effect';
import {normalizeNativeOpenAiModels,normalizeNativeOpenAiRequest,nativeCopilotModelsFromAccount,nativeEncodableModels} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-compat.js';
const make=(id:string)=>Schema.decodeUnknownSync(Model.Info)({...Model.Info.default(Schema.decodeUnknownSync(Provider.ID)('openai'),Schema.decodeUnknownSync(Model.ID)(id)),
  limit:{context:400000,input:272000,output:32000},settings:{reasoningEffort:'high',reasoningSummary:'auto',retained:true},
  variants:[{id:'none',settings:{reasoningEffort:'none'}},{id:'high',settings:{reasoningEffort:'high',reasoningSummary:'auto'},headers:{'x-retained':'yes'},body:{retained:true}}]});
test('unencodable native rows cannot poison healthy catalog rows or mutate their references',()=>{
  const diagnostic=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const good=make('healthy'),source=[good];
    expect(nativeEncodableModels(source)).toBe(source);
    const invalid={...good,time:{released:NaN}};
    expect(nativeEncodableModels([good,invalid])).toEqual([good]);
    expect(nativeEncodableModels([good,invalid])[0]).toBe(good);
    expect(nativeEncodableModels([{...good,settings:{private:1n}}])).toEqual([]);
    expect(diagnostic).toHaveBeenLastCalledWith('level=warn msg=model_response_schema_invalid name=SchemaError schemaPath=[0]');
    expect(nativeEncodableModels([{...good,limit:{...good.limit,context:NaN}}])).toEqual([]);
    expect(diagnostic).toHaveBeenLastCalledWith('level=warn msg=model_response_schema_invalid name=SchemaError schemaPath=[0].limit.context');
  } finally { diagnostic.mockRestore(); }
});
test('native model shapes use the original OpenAI OAuth policy while preserving route IDs and native variant overlays',()=>{
  const source=[make('gpt-5.6-sol'),make('gpt-5.6-luna-fast'),make('gpt-5.6'),make('gpt-5.3-codex-spark')];
  const result=normalizeNativeOpenAiModels(source,{oauth:true,compactionReserved:7500});
  expect(result.map(model=>String(model.id))).toEqual(['gpt-5.6-sol','gpt-5.6-luna-fast','gpt-5.3-codex-spark']);
  expect(result[0].limit).toEqual({context:1050000,input:263500,output:32000});
  expect(result[0].variants.map(variant=>String(variant.id))).toEqual(['high','max','ultra']);
  expect(result[0].variants[0].headers).toEqual({'x-retained':'yes'});
  expect(result[0].variants[0].body).toEqual({retained:true});
  expect(result[0].settings?.reasoningSummary).toBe('detailed');
  expect(result[2].settings).toEqual({reasoningEffort:'high',retained:true});
  expect(String(source[0].variants[0].id)).toBe('none');
  expect(source[0].settings?.reasoningSummary).toBe('auto');
  const key=normalizeNativeOpenAiModels(source,{oauth:false});
  expect(key.map(model=>String(model.id))).toContain('gpt-5.6');
  expect(key[0].limit).toEqual(source[0].limit);
});
test('native request policy keeps final Spark summary absent and leaves SIWC headers without Codex identity',()=>{
  const settings={reasoningEffort:'high',reasoningSummary:'auto',retained:true},headers={'x-retained':'yes'};
  expect(normalizeNativeOpenAiRequest(make('gpt-5.3-codex-spark'),settings,headers,{oauth:true})).toEqual({settings:{reasoningEffort:'high',retained:true},headers});
  const luna=Schema.decodeUnknownSync(Model.Info)({...make('luna-route'),modelID:'gpt-5.6-luna'});
  expect(normalizeNativeOpenAiRequest(luna,settings,headers,{oauth:true}).headers).toEqual(headers);
  expect(normalizeNativeOpenAiRequest(luna,settings,headers,{oauth:false}).headers).toBe(headers);
});
test('native Copilot catalog keeps picker priority and original utility fallback, endpoint and auto row',()=>{
  const row=(id:string,picker:boolean,endpoints:string[])=>({id,name:id,model_picker_enabled:picker,supported_endpoints:endpoints,capabilities:{limits:{max_context_window_tokens:128000,max_prompt_tokens:120000,max_output_tokens:16000},supports:{tool_calls:true,vision:true}}});
  const rows=[row('gpt-4o-mini',false,['/responses']),row('claude-route',true,['/v1/messages']),row('embedding-forbidden',true,['/responses'])];
  const priority=nativeCopilotModelsFromAccount(rows,[]);
  expect(priority.map(model=>String(model.id))).toEqual(['auto','claude-route']);
  expect(priority[1].package).toBe('aisdk:@ai-sdk/anthropic');
  expect(priority[1].settings).toEqual({baseURL:'https://api.githubcopilot.com/v1',endpoint:'messages'});
  const fallback=nativeCopilotModelsFromAccount(rows.map(row=>({...row,model_picker_enabled:false})),[]);
  expect(fallback.map(model=>String(model.id))).toEqual(['auto','gpt-4o-mini']);
  expect(fallback[1].settings?.endpoint).toBe('responses');
});

test('decoded optional fields and unchanged native rows preserve exact references',()=>{
  const original=Model.Info.default(Schema.decodeUnknownSync(Provider.ID)('other-provider'),Schema.decodeUnknownSync(Model.ID)('unchanged'));
  const source=[original];
  expect(normalizeNativeOpenAiModels(source,{oauth:false})).toBe(source);
  expect(normalizeNativeOpenAiModels(source,{oauth:false})[0]).toBe(original);
  const decoded=Schema.decodeUnknownSync(Schema.toType(Model.Info))({...make('gpt-5.6-sol'),body:undefined});
  expect(normalizeNativeOpenAiModels([decoded],{oauth:true,compactionReserved:7500})[0].limit.context).toBe(1050000);
});
