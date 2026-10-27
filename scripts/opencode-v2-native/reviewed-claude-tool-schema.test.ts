import {expect, test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Effect,Schema} from 'effect';
import {Location} from '@opencode/core/location';
import {Session} from '@opencode/schema/session';
import {SessionMessage} from '@opencode/schema/session-message';
import {Agent} from '@opencode/schema/agent';
import {Tool} from '@opencode/schema/tool';
import * as z from 'zod';
import {createManagedTaskInputSchema, managedTaskInputSchema,withManagedTaskExecution} from '../../packages/web/server/lib/opencode/runtime-host/managed-task.ts';
import type {OwnedToolInvocation} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import {rewriteReviewedMeridianLibsql} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';

const sourcePath=path.resolve(import.meta.dirname,'../../packages/web/runtime/reviewed-inputs/claude-1.11.2/node_modules/@rynfar/meridian/dist/cli-ykdmqmn4.js');

const ToolList=z.object({tools:z.array(z.object({name:z.string(),inputSchema:z.unknown(),_meta:z.unknown().optional()}))});
const UnionSchema=z.object({anyOf:z.array(z.unknown())});
type Transport={onmessage?: (message:unknown)=>void; onclose?: ()=>void; onerror?: (error:Error)=>void;
 start:()=>Promise<void>; close:()=>Promise<void>; send:(message:unknown)=>Promise<void>};
type Server={connect:(transport:Transport)=>Promise<void>; close:()=>Promise<void>};

async function withServer(server:Server, run:(request:(id:number,method:string,params?:object)=>Promise<unknown>)=>Promise<void>) {
 const messages:unknown[]=[];
 const transport:Transport={start:async()=>{},close:async()=>{},send:async(message)=>{messages.push(message);}};
 try {
  await server.connect(transport);
  const request=async(id:number,method:string,params:object={})=>{
   transport.onmessage?.({jsonrpc:'2.0',id,method,params});
   for(let i=0;i<100&&!messages.some(message=>typeof message==='object'&&message!==null&&'id' in message&&message.id===id);i++)await new Promise(resolve=>setTimeout(resolve,1));
   const message=messages.find(value=>typeof value==='object'&&value!==null&&'id' in value&&value.id===id);
   if(!message||typeof message!=='object'||!('result' in message))throw new Error('MCP request failed');
   return message.result;
  };
  await request(1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});
  await run(request);
 } finally { await server.close(); }
}

test('Claude MCP advertises managed task union without changing host validation', async()=>{
 const sdkPath=path.resolve(import.meta.dirname,'../../packages/web/runtime/reviewed-inputs/claude-1.11.2/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
 const sdkModule:unknown=await import(pathToFileURL(sdkPath).href);
 const {createSdkMcpServer}=z.object({createSdkMcpServer:z.custom<(options:unknown)=>unknown>(value=>typeof value==='function')}).parse(sdkModule);
 const original=await fs.readFile(sourcePath);
 const source=rewriteReviewedMeridianLibsql(original);
 const fragment=source.slice(source.indexOf('var PASSTHROUGH_MCP_NAME ='),source.indexOf('function createPassthroughReplayToolNameRenderer('));
 let received:unknown;
 const sdk=(options:{name:string,tools:Array<{name:string,handler:(input:unknown)=>unknown}>})=>createSdkMcpServer({...options,tools:options.tools.map(tool=>({...tool,handler:(input:unknown)=>{received=input;return tool.handler(input);}}))});
 const make=new Function('exports_external','createSdkMcpServer',fragment+';return createPassthroughMcpServer;')(z,sdk);
 const schema=Schema.toJsonSchemaDocument(createManagedTaskInputSchema({DEVRYAN_MANAGED_RESULT_CONTRACT_VERSION:'2',DEVRYAN_MANAGED_WAIT_ANY:'1'})).schema;
 const search={type:'object',properties:{query:{type:'string',minLength:2},limit:{type:'integer',minimum:1}},required:['query']};
 const mixed={type:'object',properties:{kind:{type:'string'}},required:['kind'],anyOf:[{properties:{kind:{const:'a'}}},{properties:{kind:{const:'b'}}}]};
 const tools=[{name:'devryan_task',input_schema:schema},{name:'search',input_schema:search},{name:'mcp__oc__search',input_schema:search,defer_loading:true},{name:'mixed',input_schema:mixed}];
 const instance=make(tools,undefined,'oc',false);
 expect(instance.hasDeferredTools).toBe(true);
 expect(instance.clientNameByAlias.get('search_2')).toBe('mcp__oc__search');
 await withServer(instance.server.instance,async request=>{
  const result=ToolList.parse(await request(2,'tools/list'));
  const task=result.tools.find(tool=>tool.name==='devryan_task');
  expect(task?.inputSchema).toEqual({...schema,type:'object','$schema':'http://json-schema.org/draft-07/schema#'});
  expect(UnionSchema.parse(task?.inputSchema).anyOf.length).toBe(14);
  expect(task?._meta).toEqual({'anthropic/alwaysLoad':true});
  expect(result.tools.find(tool=>tool.name==='search')?.inputSchema).toMatchObject(search);
  expect(result.tools.find(tool=>tool.name==='mixed')?.inputSchema).toEqual({...mixed,'$schema':'http://json-schema.org/draft-07/schema#'});
  expect(result.tools.find(tool=>tool.name==='search_2')?._meta).toBeUndefined();
  const start:Schema.Schema.Type<typeof managedTaskInputSchema>={action:'start',agent:'explorer',prompt:'Inspect the project',required_checks:[{name:'check',command:'bun test',paths:['src'],visual:{state:'populated',dataSource:'fixture',assertions:['visible'],reportPath:'report'}}]};
  expect(Schema.decodeUnknownSync(managedTaskInputSchema,{onExcessProperty:'error'})(start)).toEqual(start);
  expect(await request(3,'tools/call',{name:'devryan_task',arguments:start})).toEqual({content:[{type:'text',text:'passthrough'}]});
  expect(received).toEqual(start);
  const origin={kind:'plugin' as const,id:'devryan.managed-task',manifestDigest:'a'.repeat(64),capabilities:['managed-task'] as const};
  const call:OwnedToolInvocation={toolID:'devryan_task',provenance:origin,input:received,
   location:Schema.decodeUnknownSync(Location.Info)({directory:'/project',project:{id:'global',directory:'/project',canonical:'/project'}}),
   nativeContext:{sessionID:Session.ID.make('ses_root'),messageID:SessionMessage.ID.make('msg_assistant'),agent:Agent.ID.make('orchestrator'),id:Tool.CallID.make('call_1'),progress:()=>Effect.void},
   existingPermit:{token:'b'.repeat(64),sessionID:'ses_root',revision:1},recheckPermit:()=>Effect.void,nativePermissionAssert:()=>Effect.void,
   executeNative:()=>Effect.die(new Error('unowned execution'))};
  const requests:unknown[]=[];
  const execute=withManagedTaskExecution({origin,directory:'/project',rpc:async(method,input)=>{requests.push({method,input});return {task:{taskId:'task_1'}};},executeOwned:()=>Effect.die(new Error('unexpected tool'))});
  await Effect.runPromise(execute(call));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({method:'native.managed-task',input:{input:start}});
  await request(4,'tools/call',{name:'devryan_task',arguments:{action:'start',agent:'explorer'}});
  await expect(Effect.runPromise(execute({...call,input:received}))).rejects.toThrow();
  expect(requests).toHaveLength(1);
  for(const bad of [{action:'start',agent:'explorer'}, {...start,extra:true}, {...start,required_checks:[{name:'check'}]}, {action:'wait',task_id:3}])expect(()=>Schema.decodeUnknownSync(managedTaskInputSchema,{onExcessProperty:'error'})(bad)).toThrow();
 });
 // Exercise the unmodified reviewed code through the same SDK to pin the defect.
 const before=original.toString('utf8');
 const beforeFragment=before.slice(before.indexOf('var PASSTHROUGH_MCP_NAME ='),before.indexOf('function createPassthroughReplayToolNameRenderer('));
 const beforeMake=new Function('exports_external','createSdkMcpServer',beforeFragment+';return createPassthroughMcpServer;')(z,createSdkMcpServer);
 const old=beforeMake([{name:'devryan_task',input_schema:schema}],undefined,'oc',false);
 await withServer(old.server.instance,async request=>{
  const oldList=ToolList.parse(await request(2,'tools/list'));
  expect(oldList.tools[0]?.inputSchema).toMatchObject({type:'object',properties:{}});
 });
 const eager=make([{name:'devryan_task',input_schema:schema}],undefined,'oc',false);
 expect(eager.hasDeferredTools).toBe(false);
 await withServer(eager.server.instance,async request=>{
  const eagerList=ToolList.parse(await request(2,'tools/list'));
  expect(eagerList.tools[0]?.inputSchema).toEqual({...schema,type:'object','$schema':'http://json-schema.org/draft-07/schema#'});
  expect(eagerList.tools[0]?._meta).toBeUndefined();
 });
});
