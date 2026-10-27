import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Real SDK graph: a loopback remote MCP server elicits during `tools/call`.
// The owned MCP service, the Form gate and the real admission owner decide
// attribution, authorization and cancellation end to end.
test('actual SDK native questions and MCP elicitation are answered and cancelled through DevRyan admission', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-mcp-elicitation-graph-')));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp'), directory = path.join(root, 'project');
  await Promise.all([tmp, directory].map(item => fs.mkdir(item, { recursive: true })));
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
  const sdk = new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js', import.meta.url).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const source = `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import { once } from 'node:events';
      import { Effect, Layer, Logger, Schema, Stream, Context, Fiber } from 'effect';
      import { Global } from '@opencode/util/global';
      import { Tool } from '@opencode/core/tool';
      import { Bus } from '@opencode/core/bus';
      import { Form } from '@opencode/core/form';
      import { SessionEvent } from '@opencode/schema/session-event';
      import { Mcp } from '@opencode/core/mcp/index';
      import { McpTool } from '@opencode/core/tool/mcp';
      import { Config } from '@opencode/core/config';
      import { Config as ConfigSchema } from '@opencode/schema/config';
      import { Mcp as McpSchema } from '@opencode/schema/mcp';
      import { Plugin } from '@opencode/core/plugin';
      import { Permission } from '@opencode/core/permission';
      import { LocationActivity } from '@opencode/core/location-activity';
      import { LocationServiceMap } from '@opencode/core/location-service-map';
      const { OpenCode } = await import(${JSON.stringify(sdk)});
      const { OperationPermitRef, runWithRequestPermit } = await import(${JSON.stringify(host + 'native-admission-contract.ts')});
      const { createOwnedRemoteMcp, remoteMcpConfigurationDigest } = await import(${JSON.stringify(host + 'remote-mcp.ts')});
      const { createMcpElicitationCalls } = await import(${JSON.stringify(host + 'native-mcp-elicitation.ts')});
      const { createNativeAdmissionOwner } = await import(${JSON.stringify(host + 'native-admission-owner.js')});
      const { createRemoteNativeAdmissionBridge } = await import(${JSON.stringify(host + 'native-admission-bridge.ts')});
      const { createAdmissionGates } = await import(${JSON.stringify(host + 'admission-gates.ts')});
      const { createExecutionRouting } = await import(${JSON.stringify(host + 'execution-routing.ts')});
      const { createReviewedNativePluginRegistry } = await import(${JSON.stringify(host + 'native-plugin-registry.ts')});
      const { configurationOverrides } = await import(${JSON.stringify(host + 'configuration.ts')});
      const directory = process.env.DEVRYAN_GRAPH_DIRECTORY;
      const wait = async (action,accept,label) => { const end=Date.now()+10000;
        while(Date.now()<end){const value=await action();if(accept(value))return value;await new Promise(r=>setTimeout(r,5));}throw new Error(label); };
      // ---- loopback MCP server: every tools/call elicits before it answers ----
      const sockets=new Set(), streams=new Set(), pending=new Map(), results=[];
      let capabilities, nextElicitation=0, plan={mode:'form'}, holdCalls=0, held=[];
      const elicitationRequest=()=>plan.mode==='url'
        ? {mode:'url',message:'Sign in to continue',url:plan.url,elicitationId:'el_'+nextElicitation}
        : {mode:'form',message:'How many items?',requestedSchema:{type:'object',properties:{count:{type:'integer',minimum:1,maximum:5}},required:['count']}};
      const elicit=(response,callID)=>{
        const id='elicit_'+(nextElicitation++);
        const settled=new Promise(resolve=>pending.set(id,resolve));
        const params=elicitationRequest();
        response.write('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',id,method:'elicitation/create',params})+'\\n\\n');
        if(plan.complete)setTimeout(()=>{for(const stream of streams)stream.write('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/elicitation/complete',params:{elicitationId:params.elicitationId}})+'\\n\\n');},50);
        settled.then(result=>{results.push(result);
          response.write('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',id:callID,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}})+'\\n\\n');response.end();});
      };
      const server=http.createServer(async(request,response)=>{
        try{
          const url=new URL(request.url,'http://127.0.0.1');
          const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
          if(url.pathname!=='/mcp')return json(404,{error:'unknown owned route'});
          if(request.method==='GET'){response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});response.write(': owned stream\\n\\n');streams.add(response);request.on('close',()=>streams.delete(response));return;}
          if(request.method==='DELETE'){response.writeHead(200);response.end();return;}
          const chunks=[];for await(const chunk of request)chunks.push(chunk);
          const input=JSON.parse(Buffer.concat(chunks).toString());
          if(input.method===undefined&&pending.has(input.id)){const resolve=pending.get(input.id);pending.delete(input.id);resolve(input.result??{error:input.error});response.writeHead(202);response.end();return;}
          if(input.id===undefined){response.writeHead(202);response.end();return;}
          let result;
          if(input.method==='initialize'){capabilities=input.params.capabilities;result={protocolVersion:input.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-elicitation',version:'1'}};}
          else if(input.method==='tools/list')result={tools:[{name:'confirm',description:'Owned elicitation fixture',inputSchema:{type:'object',properties:{}}}]};
          else if(input.method==='tools/call'){
            response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
            if(holdCalls>0){held.push({response,id:input.id});if(held.length===holdCalls){const calls=held;held=[];holdCalls=0;for(const call of calls)elicit(call.response,call.id);}return;}
            return elicit(response,input.id);
          }
          else if(['prompts/list','resources/list'].includes(input.method))result={[input.method==='prompts/list'?'prompts':'resources']:[]};
          else if(input.method==='resources/templates/list')result={resourceTemplates:[]};
          else return json(200,{jsonrpc:'2.0',id:input.id,error:{code:-32601,message:'Unknown owned method'}});
          json(200,{jsonrpc:'2.0',id:input.id,result});
        }catch(error){response.writeHead(500);response.end('owned fixture failure');throw error;}
      });
      server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
      server.listen(0,'127.0.0.1');await once(server,'listening');
      const base='http://127.0.0.1:'+server.address().port;
      const fetchNative=globalThis.fetch;
      globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
        if(url.hostname!=='127.0.0.1')throw new Error('external_network_forbidden');return fetchNative(input,init);};
      // ---- DevRyan owners: real admission owner, remote bridge, owned MCP and gates ----
      const plain=Schema.decodeUnknownSync(McpSchema.RemoteConfig)({type:'remote',url:base+'/mcp',oauth:false,codemode:false,protocol:'legacy',timeout:{startup:5000,catalog:5000,execution:8000}});
      const origin={kind:'native',id:'devryan.remote-mcp',manifestDigest:'a'.repeat(64),capabilities:['network']};
      const nativePlugins=new Map(createReviewedNativePluginRegistry('b'.repeat(64)));nativePlugins.set(origin.id,origin);
      const sessionRows=new Map(), owned=new Set(), webAuthorizations=[], journal=[];
      const admissionOwner=createNativeAdmissionOwner({directory,ownerID:'mcp-elicitation-graph',
        runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},
        getSession:async id=>sessionRows.get(id),recordDiagnostic:entry=>journal.push(entry),
        // Production policy: a form effect is never a detached operation.
        authorizeOperation:async request=>{if(['form.reply','form.cancel'].includes(request.operation))throw Object.assign(new Error('native_owned_operation_required'),{code:'native_owned_operation_required',status:403});},
        // The caller (one "user") may act only on the sessions it owns.
        captureWebAuthorization:async spec=>{webAuthorizations.push(spec.sessionID);const check=async()=>{if(!owned.has(spec.sessionID))throw Object.assign(new Error('native_session_access_denied'),{code:'native_session_access_denied',status:403});};await check();return check;}});
      const bridge=createRemoteNativeAdmissionBridge({rpc:(method,params)=>admissionOwner.handleRpc(method,structuredClone(params))});
      const controls=[];
      const routing=createExecutionRouting({directory,bridge,rpc:async(method,params)=>{
        await admissionOwner.recheckExecution(params);
        controls.push(method);
        return method.endsWith('control-begin')?{lease:{token:'question-control'}}:{};
      }});
      const calls=createMcpElicitationCalls();
      const ownedMcp=createOwnedRemoteMcp({registrationOrigin:origin,reviewedConfigurationOrigins:new Map(['opencode.config.mcp','opencode.mcp.codemode.defaults','opencode.provider.opencode'].map(id=>[id,nativePlugins.get(id)])),
        controllerInstanceID:'00000000-0000-4000-8000-000000000002',elicitationCalls:calls,
        reviewedServersByDirectory:new Map([[directory,new Map([['plain',{config:plain,configurationDigest:remoteMcpConfigurationDigest(plain)}]])]]),
        captureOAuthGrant:()=>Effect.die(new Error('unexpected oauth')),captureConnectionGrant:()=>Effect.die(new Error('unexpected oauth')),authorizeControl:(_b,_o,a)=>a,
        authorizeCall:(_invocation,_binding,action)=>action,executeOwnedFallback:routing.executeOwned,
        withCredentialMutation:()=>Effect.die(new Error('unexpected credential mutation'))});
      const gates=createAdmissionGates({bridge,nativePlugins,executeOwned:ownedMcp.executeOwned,mcpElicitationCalls:calls});await gates.controls.openStartup();
      const document=new ConfigSchema.Document({type:'document',info:Schema.decodeUnknownSync(ConfigSchema.Info)({snapshots:false,warming:false,plugins:[],update:'disable'})});
      let nativeBus,map;const asserted=[];
      const replacements=[...configurationOverrides({}),Config.node.replace(Layer.succeed(Config.Service,{entries:()=>Effect.succeed([document]),compatibility:()=>Effect.succeed({claude:[],agents:[]}),changes:()=>Stream.empty})),
        Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,cache:process.env.XDG_CACHE_HOME,tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),
        ...gates.overrides,...ownedMcp.overrides,...routing.overrides,
        Bus.node.replace(Bus.node.mapLayer(layer=>Layer.effect(Bus.Service,Effect.gen(function*(){nativeBus=yield* Bus.Service;return nativeBus;})).pipe(Layer.provide(layer)))),
        Permission.node.replace(Permission.node.mapLayer(layer=>Layer.effect(Permission.Service,Effect.gen(function*(){const inner=yield* Permission.Service;return {...inner,assert:input=>{asserted.push({action:input.action,metadata:input.metadata});return inner.assert(input);}};})).pipe(Layer.provide(layer)))),
        LocationActivity.node.replace(LocationActivity.node.mapLayer(layer=>Layer.effect(LocationActivity.Service,Effect.gen(function*(){const inner=yield* LocationActivity.Service;map=yield* LocationServiceMap.Service;return inner;})).pipe(Layer.provide(layer))))];
      const proof={};
      try{
        await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
          const api=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides:replacements});
          const at=action=>action.pipe(Effect.provide(LocationServiceMap.Service.get({directory})),Effect.provideService(LocationServiceMap.Service,map));
          const sessions=[];
          for(let index=0;index<2;index++){
            const session=yield* api.sessions.create({location:{directory},permissions:[{action:'*',resource:'*',effect:'allow'}]});
            sessionRows.set(session.id,{id:session.id,directory});sessions.push(session.id);
          }
          const [alice,bob]=sessions;owned.add(alice);owned.add(bob);
          yield* api.agent.list({location:{directory}});
          const {view,forms}=yield* at(Effect.gen(function*(){
            const plugin=yield* Plugin.Service;yield* plugin.awaitActivation;
            const mcpt=yield* McpTool.Service,tools=yield* Tool.Service;yield* mcpt.flush;
            yield* Effect.promise(()=>wait(()=>Effect.runPromise(tools.list()),rows=>rows.some(tool=>tool.id==='plain_confirm'),'plain_confirm never registered'));
            const shell=(yield* tools.list()).find(tool=>tool.id==='shell');
            assert.ok(shell.description.includes('mapped private project $PWD'));
            assert.ok(shell.description.includes('$TMPDIR')&&shell.description.includes('$DEVRYAN_SESSION_TMP'));
            assert.ok(shell.description.includes('Fail fast'));
            return {view:yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]),forms:yield* Form.Service};
          }));
          assert.ok(capabilities?.elicitation,'the native client advertises elicitation');
          let turn=0;
          // One real tool call: runner admission, then the gated native executor.
          const invoke=(sessionID,name='plain_confirm',input={})=>Effect.gen(function*(){
            const index=turn++,messageID='msg_assistant'+index,callID='call_'+index;
            const runner=yield* Effect.promise(()=>bridge.authorize({operation:'runner.drain',sessionID}));
            yield* nativeBus.publish(SessionEvent.Step.Started,{sessionID,assistantMessageID:messageID,agent:'orchestrator',model:{providerID:'openai',id:'fixture'},started:Date.now()});
            yield* nativeBus.publish(SessionEvent.Tool.Called,{sessionID,assistantMessageID:messageID,id:callID,input:{},executed:false});
            try{
              const result=yield* view.execute({sessionID,messageID,agent:'orchestrator',call:{type:'tool-call',id:callID,name,input}}).pipe(Effect.provideService(OperationPermitRef,runner));
              return {messageID,callID,result:name==='plain_confirm'?JSON.parse(result.content.find(part=>part.type==='text').text):result};
            }finally{yield* Effect.promise(()=>bridge.release(runner));}
          });
          const pendingForm=()=>Effect.promise(()=>wait(()=>Effect.runPromise(forms.list()),rows=>rows.length===1,'elicitation form never appeared')).pipe(Effect.map(rows=>rows[0]));
          // The DevRyan web path: one web permit per request for the claimed session.
          const web=(claimed,method,suffix,body,work)=>Effect.promise(()=>admissionOwner.withWebOperation({operation:'questions.reply',method,
            path:'/api/session/global/form/'+suffix,...(body?{body}:{}),directory,elicitationSessionID:claimed},
            ()=>runWithRequestPermit(new Headers(admissionOwner.requestHeaders()),()=>Effect.runPromise(work))));
          const refusal=effect=>effect.pipe(Effect.as('accepted'),Effect.catchCause(cause=>Effect.succeed(String(cause.toString?.()??cause))));

          // 1. One in-flight call: the form is stamped with the caller; a reply
          //    for another owned session is refused in core; the owner answers.
          const first=yield* Effect.forkChild(invoke(alice));
          const form=yield* pendingForm();
          assert.equal(form.sessionID,'global');assert.equal(form.metadata.kind,'mcp-elicitation');
          assert.equal(form.metadata.devryan.sessionID,alice);
          const wrong=yield* refusal(web(bob,'POST',form.id+'/reply',{answer:{count:3}},forms.reply({id:form.id,answer:{count:3}})));
          assert.match(wrong,/native_permit_lineage_mismatch/);
          owned.delete(alice);
          const denied=yield* refusal(web(alice,'POST',form.id+'/reply',{answer:{count:3}},forms.reply({id:form.id,answer:{count:3}})));
          assert.match(denied,/native_session_access_denied/);
          owned.add(alice);
          const missing=yield* refusal(web(undefined,'POST',form.id+'/reply',{answer:{count:3}},forms.reply({id:form.id,answer:{count:3}})));
          assert.match(missing,/native_web_operation_unavailable/);
          assert.deepEqual(yield* forms.state(form.id),{status:'pending'});
          yield* web(alice,'POST',form.id+'/reply',{answer:{count:3}},forms.reply({id:form.id,answer:{count:3}}));
          const answered=yield* Fiber.join(first);
          assert.deepEqual(answered.result,{action:'accept',content:{count:3}});
          assert.deepEqual(form.metadata.devryan,{sessionID:alice,messageID:answered.messageID,callID:answered.callID});
          proof.answered=answered.result;

          // 2. Decline: cancel through the attributed session's permit.
          const second=yield* Effect.forkChild(invoke(bob));
          const declined=yield* pendingForm();
          assert.equal(declined.metadata.devryan.sessionID,bob);
          yield* web(bob,'DELETE',declined.id,undefined,forms.cancel(declined.id));
          proof.declined=(yield* Fiber.join(second)).result;
          assert.deepEqual(proof.declined,{action:'cancel'});

          // 3. Two concurrent calls on one server: ambiguous, both cancelled at once.
          holdCalls=2;
          const started=Date.now();
          const both=yield* Effect.all([invoke(alice),invoke(bob)],{concurrency:2});
          proof.concurrent=both.map(row=>row.result);
          assert.deepEqual(proof.concurrent,[{action:'cancel'},{action:'cancel'}]);
          assert.ok(Date.now()-started<5000,'ambiguous requests never wait for a timeout');
          assert.deepEqual(yield* forms.list(),[]);

          // 4. URL mode: https is shown and settled by the server's completion
          //    notice; any other scheme is refused before a form exists.
          plan={mode:'url',url:'https://example.invalid/oauth?state=fixture',complete:true};
          proof.urlCompleted=(yield* invoke(alice)).result;
          assert.deepEqual(proof.urlCompleted,{action:'accept'});
          plan={mode:'url',url:'javascript:alert(1)'};
          proof.urlRefused=(yield* invoke(alice)).result;
          assert.deepEqual(proof.urlRefused,{action:'cancel'});
          proof.journal=journal.filter(row=>row.event==='native_mcp_elicitation').map(row=>row.payload.reason);
          assert.deepEqual(proof.journal,['ambiguous','ambiguous','url_refused']);
          assert.ok(!JSON.stringify(journal).includes('javascript'));
          proof.webAuthorizations=webAuthorizations;
          // Approval cards get the reviewed server and tool beside the native input.
          assert.ok(asserted.length>0&&asserted.every(row=>row.action==='plain_confirm'));
          assert.deepEqual(asserted[0].metadata,{input:{},mcp:{server:'plain',tool:'confirm'}});
          // Native question uses the same real Form service and request permits,
          // with an owned control lease around the pending user interaction.
          const questionInput={questions:[{question:'Pick a color?',header:'Color',options:[{label:'Red',description:'warm'},{label:'Blue',description:'cool'}]}]};
          const native=yield* Effect.forkChild(invoke(alice,'question',questionInput));
          const nativeForm=yield* pendingForm();
          assert.equal(nativeForm.sessionID,alice);
          assert.deepEqual((yield* forms.list()).map(row=>row.id),[nativeForm.id],'pending question survives a fresh list/reload');
          const nativeWeb=(form,method,body,action)=>Effect.promise(()=>admissionOwner.withWebOperation({operation:'questions.reply',method,
            path:'/api/session/'+alice+'/form/'+form.id+(method==='POST'?'/reply':''),...(body?{body}:{}),directory,sessionID:alice},
            ()=>runWithRequestPermit(new Headers(admissionOwner.requestHeaders()),()=>Effect.runPromise(action))));
          const answer=Object.fromEntries(nativeForm.fields.map(field=>[field.key,field.options?.[0]?.value??'Red']));
          yield* nativeWeb(nativeForm,'POST',{answer},forms.reply({id:nativeForm.id,answer}));
          yield* Fiber.join(native);
          assert.deepEqual(yield* forms.list(),[]);
          const cancelled=yield* Effect.forkChild(invoke(alice,'question',questionInput));
          const cancelledForm=yield* pendingForm();
          yield* nativeWeb(cancelledForm,'DELETE',undefined,forms.cancel(cancelledForm.id));
          yield* Fiber.await(cancelled);
          assert.deepEqual(yield* forms.list(),[]);
          assert.deepEqual(controls,['execution.native.control-begin','execution.native.control-finish','execution.native.control-begin','execution.native.control-finish']);
          proof.nativeQuestion=true;
        }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
        process.stdout.write(JSON.stringify(proof));
      }finally{admissionOwner.dispose();for(const stream of streams)stream.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
    `;
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: repository,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', DEVRYAN_GRAPH_DIRECTORY: directory }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child?.kill('SIGKILL'), 45_000);
    try {
      const stdout = child.stdout, stderr = child.stderr;
      if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw new Error('Owned pipes required');
      const [output, errors, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(errors.slice(0, 8192));
      const proof: { answered: unknown; declined: unknown; concurrent: unknown[]; urlCompleted: unknown; urlRefused: unknown;
        journal: string[]; webAuthorizations: string[]; nativeQuestion: boolean } = JSON.parse(output);
      expect(proof.answered).toEqual({ action: 'accept', content: { count: 3 } });
      expect(proof.declined).toEqual({ action: 'cancel' });
      expect(proof.concurrent).toEqual([{ action: 'cancel' }, { action: 'cancel' }]);
      expect(proof.urlCompleted).toEqual({ action: 'accept' });
      expect(proof.urlRefused).toEqual({ action: 'cancel' });
      expect(proof.journal).toEqual(['ambiguous', 'ambiguous', 'url_refused']);
      expect(proof.webAuthorizations.length).toBeGreaterThanOrEqual(4);
      expect(proof.nativeQuestion).toBe(true);
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 50_000);
