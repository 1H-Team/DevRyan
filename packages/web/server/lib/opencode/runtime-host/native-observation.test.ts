import {expect,test} from 'vitest';
import {Cause} from 'effect';
import {AIError,HttpContext,RateLimitError,TimeoutError,TransportError} from '@opencode/ai/effect';
import {ai} from '@opencode/ai/effect';
import {model as compatibleModel} from '@opencode/ai/providers/openai-compatible';
import {nativeProviderFailureCode,nativeProviderFailureTarget,projectNativeProviderFailure,withNativeHeaderDeadline} from './native-observation.js';

const model={providerID:'openai',modelID:'gpt-5.5'};
const transport=(fields:Partial<ConstructorParameters<typeof TransportError>[0]>)=>new AIError({reason:new TransportError({message:'secret message body',transport:'http',operation:'request',...fields})});
const url='https://api.openai.com/v1/responses?api_key=secret';

test('pre-header transport failures split into connect and headers by code',()=>{
 const state={preparedAt:100,startedAt:1_000,url};
 expect(projectNativeProviderFailure({error:transport({code:'ECONNREFUSED',url}),state,now:1_250,...model})).toEqual({transport:'http',failure:{
  phase:'connect',elapsedMs:250,code:'ECONNREFUSED',host:'api.openai.com',port:443,...model,providerRequestID:null}});
 // Header timeouts wrap the middleware from outside; only the typed error names them.
 expect(projectNativeProviderFailure({error:transport({code:'Timeout'}),state,now:121_000,...model})?.failure).toMatchObject({phase:'headers',code:'Timeout',elapsedMs:120_000,host:'api.openai.com'});
 expect(projectNativeProviderFailure({error:transport({code:'ECONNRESET'}),state:{preparedAt:100},now:600,...model})?.failure).toMatchObject({phase:'headers',elapsedMs:500,host:null,port:null});
});

test('stream failures carry idle time and the provider request ID, never content or the full URL',()=>{
 const http=new HttpContext({url:'http://127.0.0.1:3456/v1/messages?beta=true',status:200,headers:{'request-id':'req_011CUy','authorization':'Bearer secret'}});
 const projected=projectNativeProviderFailure({error:transport({operation:'read',code:'ECONNRESET',http,url:http.url}),
  state:{preparedAt:0,startedAt:1_000,lastByteAt:4_000,providerRequestID:'ignored'},now:79_000,providerID:'anthropic',modelID:'claude-x'});
 expect(projected).toEqual({transport:'http',failure:{phase:'stream',elapsedMs:78_000,sinceLastByteMs:75_000,code:'ECONNRESET',host:'127.0.0.1',port:3456,
  providerID:'anthropic',modelID:'claude-x',providerRequestID:'req_011CUy'}});
 const text=JSON.stringify(projected);
 for(const forbidden of ['secret','/v1/','beta','Bearer'])expect(text.includes(forbidden)).toBe(false);
 // Without headers on the error, the request ID observed at response headers is kept.
 expect(projectNativeProviderFailure({error:transport({operation:'read',code:'Timeout'}),state:{preparedAt:0,startedAt:10,providerRequestID:'req_seen',url},now:300,...model})?.failure)
  .toMatchObject({phase:'stream',sinceLastByteMs:290,providerRequestID:'req_seen'});
});

test('WebSocket and timeout reasons project; status, auth and output errors do not',()=>{
 expect(projectNativeProviderFailure({error:new AIError({reason:new TransportError({message:'x',transport:'websocket',operation:'request',phase:'connect',code:'Timeout',url:'wss://api.openai.com/v1/responses'})}),
  state:{preparedAt:0,startedAt:5},now:15_005,...model})).toMatchObject({transport:'ws',failure:{phase:'connect',code:'Timeout',host:'api.openai.com',port:443}});
 expect(projectNativeProviderFailure({error:new AIError({reason:new TimeoutError({message:'x'})}),state:{preparedAt:0},now:1,...model})?.failure).toMatchObject({phase:'headers',code:'Timeout'});
 expect(projectNativeProviderFailure({error:new AIError({reason:new RateLimitError({message:'x'})}),state:{preparedAt:0},now:1,...model})).toBeNull();
 for(const error of [new Error('ECONNRESET'),null,'ECONNRESET',{_tag:'AI.Error',reason:null}])expect(projectNativeProviderFailure({error,state:{preparedAt:0},now:1,...model})).toBeNull();
});

test('native codes are read from Node, undici and Bun cause chains with bounded values only',()=>{
 const undici=Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'),{code:'ECONNREFUSED'})});
 expect(nativeProviderFailureCode({_tag:'HttpClientError',reason:{_tag:'TransportError',cause:undici}})).toBe('ECONNREFUSED');
 expect(nativeProviderFailureCode(Object.assign(new Error('Unable to connect'),{code:'ConnectionRefused'}))).toBe('ConnectionRefused');
 expect(nativeProviderFailureCode(new Cause.TimeoutError())).toBe('Timeout');
 expect(nativeProviderFailureCode({_tag:'HttpClientError',reason:{_tag:'DecodeError',cause:{code:'read ECONNRESET with spaces'}}})).toBe('DecodeError');
 expect(nativeProviderFailureCode(new Error('opaque'))).toBe('unknown');
 expect(projectNativeProviderFailure({error:transport({cause:undici}),state:{preparedAt:0},now:1,...model})?.failure).toMatchObject({phase:'connect',code:'ECONNREFUSED'});
});

test('targets keep only the hostname and port',()=>{
 expect(nativeProviderFailureTarget('https://user:pass@opencode.ai/zen/v1/chat?key=secret#x')).toEqual({host:'opencode.ai',port:443});
 expect(nativeProviderFailureTarget('http://[::1]:8080/path')).toEqual({host:'::1',port:8080});
 expect(nativeProviderFailureTarget('not a url')).toEqual({host:null,port:null});
 expect(nativeProviderFailureTarget(undefined)).toEqual({host:null,port:null});
});

test('requests left on the core header default get the DevRyan header deadline; configured waits are kept',()=>{
 const zen=compatibleModel('deepseek-v4.1-flash',{baseURL:'http://127.0.0.1:1/v1',provider:'opencode'});
 const unset=ai.request({model:zen,prompt:'hi'});
 expect(withNativeHeaderDeadline(unset).http).toMatchObject({headerTimeout:45_000});
 expect(withNativeHeaderDeadline(unset).http?.chunkTimeout).toBeUndefined();
 const coreDefault=ai.request({model:zen,prompt:'hi',http:{headerTimeout:300_000,chunkTimeout:900_000}});
 expect(withNativeHeaderDeadline(coreDefault).http).toMatchObject({headerTimeout:45_000,chunkTimeout:900_000});
 const configured=ai.request({model:zen,prompt:'hi',http:{headerTimeout:60_000}});
 expect(withNativeHeaderDeadline(configured)).toBe(configured);
 const disabled=ai.request({model:zen,prompt:'hi',http:{headerTimeout:false}});
 expect(withNativeHeaderDeadline(disabled)).toBe(disabled);
});

test('the claude-agent route keeps Claude Code\'s own timeouts and gets no header deadline',()=>{
 const claude=compatibleModel('claude-opus-5-5',{baseURL:'http://127.0.0.1:1/v1',provider:'claude-agent'});
 const request=ai.request({model:claude,prompt:'hi'});
 expect(withNativeHeaderDeadline(request)).toBe(request);
 // The retired Meridian `anthropic` route is no longer exempt.
 const anthropic=ai.request({model:compatibleModel('claude-opus-5-5',{baseURL:'http://127.0.0.1:3456/v1',provider:'anthropic'}),prompt:'hi'});
 expect(withNativeHeaderDeadline(anthropic).http).toMatchObject({headerTimeout:45_000});
});
