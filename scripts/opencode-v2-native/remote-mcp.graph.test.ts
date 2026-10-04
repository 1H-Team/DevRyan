import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('actual SDK remote MCP services bind two locations, OAuth refresh and reload lifetimes', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const base = path.join(repository, '.cache/v2-validation'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'remote-mcp-graph-'));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
  const directories = [path.join(root, 'one'), path.join(root, 'two')];
  await Promise.all([tmp, ...directories].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
  const sdk = new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js', import.meta.url).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // Every native import occurs in a fresh owned process after globals have
    // been isolated. HTTP requests can reach only this loopback issuer/server.
    const source = `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import { once } from 'node:events';
      import { Effect, Layer, Logger, Schema, Cause, Stream, Context } from 'effect';
      import { Global } from '@opencode/util/global';
      import { Tool } from '@opencode/core/tool';
      import { Bus } from '@opencode/core/bus';
      import { SessionEvent } from '@opencode/schema/session-event';
      import { SessionStore } from '@opencode/core/session/store';
      import { Mcp } from '@opencode/core/mcp/index';
      import { McpTool } from '@opencode/core/tool/mcp';
      import { Config } from '@opencode/core/config';
      import { ConfigMcpPlugin } from '@opencode/core/config/plugin/mcp';
      import { Config as ConfigSchema } from '@opencode/schema/config';
      import { Mcp as McpSchema } from '@opencode/schema/mcp';
      import { Permission } from '@opencode/core/permission';
      import { Integration } from '@opencode/core/integration';
      import { Credential } from '@opencode/core/credential';
      import { Plugin } from '@opencode/core/plugin';
      import { Location } from '@opencode/core/location';
      import { LocationActivity } from '@opencode/core/location-activity';
      import { LocationServiceMap } from '@opencode/core/location-service-map';
      const { OpenCode } = await import(${JSON.stringify(sdk)});
      const { OperationPermitRef } = await import(${JSON.stringify(host + 'native-admission-contract.ts')});
      const { RegistrationOriginRef } = await import(${JSON.stringify(host + 'registration-origin.ts')});
      const { createOwnedRemoteMcp,remoteMcpConfigurationDigest,remoteMcpDigest } = await import(${JSON.stringify(host + 'remote-mcp.ts')});
      const { createManagedOrchestrationPrivateHost } = await import(${JSON.stringify(new URL('../../packages/web/server/lib/orchestration/private-host.js',import.meta.url).href)});
      const { createPrimaryRecoveryController } = await import(${JSON.stringify(new URL('../../packages/harness-runtime/lib/provider-recovery.js',import.meta.url).href)});
      const { projectMessagePage } = await import(${JSON.stringify(new URL('../../packages/web/server/lib/opencode/v2/projection/messages.js',import.meta.url).href)});
      const { createNativeSessionContextOwner } = await import(${JSON.stringify(host + 'native-session-context-owner.js')});
      const { createNativeSessionContext } = await import(${JSON.stringify(host + 'native-session-context.ts')});
      const { createNativeAdmissionOwner } = await import(${JSON.stringify(host + 'native-admission-owner.js')});
      const { createRemoteNativeAdmissionBridge } = await import(${JSON.stringify(host + 'native-admission-bridge.ts')});
      const { createExecutionRouting } = await import(${JSON.stringify(host + 'execution-routing.ts')});
      const { createAdmissionGates } = await import(${JSON.stringify(host + 'admission-gates.ts')});
      const { createReviewedNativePluginRegistry } = await import(${JSON.stringify(host + 'native-plugin-registry.ts')});
      const { configurationOverrides } = await import(${JSON.stringify(host + 'configuration.ts')});
      const directories = JSON.parse(process.env.DEVRYAN_GRAPH_DIRECTORIES);
      const sessionRows=new Map(); const sessions = new Set(), calls = [], permissions = [], mutations = [], credentialIDs = new Set();
      const sockets = new Set(), streams = new Set();
      let tokenRevision = 0, refreshes = 0, rejectAccess = false, revoked = false, originalCredentials, composedCredentials, map, changeDuringRemoval=false, removalGrants=0;
      const wait = async (action,accept,label) => { const end=Date.now()+10000;
        while(Date.now()<end){const value=await action();if(accept(value))return value;await new Promise(r=>setTimeout(r,10));}throw new Error(label); };
      const server = http.createServer(async (request,response) => {
        try {
          const url = new URL(request.url,'http://127.0.0.1');
          const json = (status,value,headers={}) => { response.writeHead(status,{'content-type':'application/json',...headers});response.end(JSON.stringify(value)); };
          if(url.pathname==='/metadata') return json(200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',
            response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
          if(url.pathname==='/authorize') {
            const redirect = new URL(url.searchParams.get('redirect_uri')); redirect.searchParams.set('state',url.searchParams.get('state'));
            redirect.searchParams.set('code','owned-fixture-code'); response.writeHead(302,{location:redirect.href});response.end(); return;
          }
          const chunks=[];for await(const chunk of request){chunks.push(chunk);if(chunks.reduce((n,b)=>n+b.length,0)>65536)throw new Error('request bound');}
          const text=Buffer.concat(chunks).toString();
          if(url.pathname==='/token') {
            const form=new URLSearchParams(text);
            assert.ok(['authorization_code','refresh_token'].includes(form.get('grant_type')));
            if(form.get('grant_type')==='refresh_token')refreshes++;
            tokenRevision++;rejectAccess=false;
            return json(200,{access_token:'fixture-access-'+tokenRevision,refresh_token:'fixture-refresh-'+tokenRevision,token_type:'Bearer',expires_in:3600,issuer:base});
          }
          if(!['/plain','/oauth'].includes(url.pathname)) return json(404,{error:'unknown owned route'});
          if(url.pathname==='/oauth' && (rejectAccess || request.headers.authorization!=='Bearer fixture-access-'+tokenRevision))
            return json(401,{error:'fixture_auth_required'},{'www-authenticate':'Bearer resource_metadata="'+base+'/metadata"'});
          if(request.method==='GET') { response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
            response.write(': owned stream\\n\\n');streams.add(response);request.on('close',()=>streams.delete(response));return; }
          if(request.method==='DELETE'){response.writeHead(200);response.end();return;}
          const input=JSON.parse(text);
          if(input.id===undefined){response.writeHead(202);response.end();return;}
          let result;
          if(input.method==='initialize') result={protocolVersion:input.params.protocolVersion,capabilities:{tools:{listChanged:true},prompts:{},resources:{}},serverInfo:{name:'owned-loopback',version:'1'}};
          else if(input.method==='tools/list')result={tools:[{name:'lookup',description:'Owned fixture lookup',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
          else if(input.method==='tools/call'){calls.push({endpoint:url.pathname,name:input.params.name});result={content:[{type:'text',text:'owned-loopback-result'}],isError:false};}
          else if(input.method==='prompts/list')result={prompts:[]};
          else if(input.method==='resources/list')result={resources:[]};
          else if(input.method==='resources/templates/list')result={resourceTemplates:[]};
          else return json(200,{jsonrpc:'2.0',id:input.id,error:{code:-32601,message:'Unknown owned method'}});
          json(200,{jsonrpc:'2.0',id:input.id,result});
        } catch(error){response.writeHead(500);response.end('owned fixture failure');throw error;}
      });
      server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
      server.listen(0,'127.0.0.1');await once(server,'listening');
      const base='http://127.0.0.1:'+server.address().port;
      const fetchNative=globalThis.fetch;
      globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
        if(url.hostname!=='127.0.0.1')throw new Error('external_network_forbidden');return fetchNative(input,init);};
      const plain=Schema.decodeUnknownSync(McpSchema.RemoteConfig)({type:'remote',url:base+'/plain',oauth:false,codemode:false,protocol:'legacy',timeout:{startup:5000,catalog:5000,execution:5000}});
      const oauth=Schema.decodeUnknownSync(McpSchema.RemoteConfig)({type:'remote',url:base+'/oauth',codemode:false,protocol:'legacy',oauth:{client_id:'owned-fixture-client',auth_server_metadata_url:base+'/metadata'},timeout:{startup:5000,catalog:5000,execution:5000}});
      const origin={kind:'native',id:'devryan.remote-mcp',manifestDigest:'a'.repeat(64),capabilities:['network']};
      const nativePlugins=new Map(createReviewedNativePluginRegistry('b'.repeat(64)));nativePlugins.set(origin.id,origin);
      const grant=()=>Effect.succeed({reauthorize:Effect.sync(()=>{if(revoked)throw new Error('fixture_access_revoked');})});
      const observed=[], controlCalls=[], primaryObservations=[];
      let runStore,nativeBus,revokedAdmission=false,pausedRead;
      const messages=async sessionID=>projectMessagePage(await runStore(SessionStore.Service.use(store=>store.messages({sessionID,order:'asc'}))),{sessionID,directory:sessionRows.get(sessionID).directory}).records;
      const primary=createPrimaryRecoveryController({directory:process.env.HOME+'/primary',mode:'enforce',isManaged:()=>true,
        pollMs:1000000,authorize:async()=>true,observeTurn:async record=>({session:sessionRows.get(record.sessionID),complete:true,status:'busy',messages:await messages(record.sessionID)}),
        promptSession:async()=>{throw Error('unexpected recovery');},abortSession:async()=>{throw Error('unexpected abort');}});
      await primary.initialize();await primary.plugin({action:'hello',instanceID:'real-mcp-primary',policyVersion:1,version:'2.0.20'});
      const admissionOwner=createNativeAdmissionOwner({directory:directories[0],ownerID:'real-mcp-graph',
        runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},
        getSession:async id=>{if(pausedRead){const read=pausedRead;read.entered.resolve();await read.release.promise;}return sessionRows.get(id);},authorizeOperation:async()=>{if(revoked||revokedAdmission)throw Object.assign(new Error('fixture_access_revoked'),{code:'fixture_access_revoked'});}});
      const contextOwner=createNativeSessionContextOwner({admissionOwner,instanceID:'real-mcp-primary',primaryRuntime:primary,
        openCodeClient:{sessions:{get:async id=>sessionRows.get(id),message:async(id,messageID)=>(await messages(id)).find(row=>row.info.id===messageID)}}});
      const privateHost=createManagedOrchestrationPrivateHost({handleRpc:async({method,params},context)=>{
        if(method==='native.session-context.observe-tool'){assert.equal(params.authorization.input.toolID,'plain.lookup');assert.equal(params.authorization.input.nativeToolID,'plain_lookup');assert.equal(params.tool,'plain_lookup');const result=await contextOwner.observeTool(params,context);primaryObservations.push({sessionID:params.sessionID,phase:params.phase,tracked:result.tracked!==false});return result;}
        if(method.startsWith('execution.native.control-')){await admissionOwner.recheckExecution(params);controlCalls.push(method);return method.endsWith('control-begin')?{lease:{token:'real-control'}}:{};}
        return admissionOwner.handleRpc(method,params);}});
      const privateEnvironment=await privateHost.start();
      const privateRpc=async(method,params)=>{const response=await fetch(privateEnvironment.DEVRYAN_ORCHESTRATION_URL,{method:'POST',headers:{authorization:'Bearer '+privateEnvironment.DEVRYAN_ORCHESTRATION_TOKEN,'content-type':'application/json'},body:JSON.stringify({method,params})});const result=await response.json();if(!response.ok||!result.ok)throw Object.assign(new Error(result.error.code),{code:result.error.code,status:response.status});return result.result;};
      const bridge=createRemoteNativeAdmissionBridge({rpc:privateRpc});
      const routing=createExecutionRouting({directory:directories[0],bridge,rpc:privateRpc});
      const mutationNegatives=[];
      const owned=createOwnedRemoteMcp({registrationOrigin:origin,reviewedConfigurationOrigins:new Map(['opencode.config.mcp','opencode.mcp.codemode.defaults','opencode.provider.opencode'].map(id=>[id,nativePlugins.get(id)])),controllerInstanceID:'00000000-0000-4000-8000-000000000001',
        reviewedServersByDirectory:new Map(directories.map(directory=>[directory,new Map([['plain',{config:plain,configurationDigest:remoteMcpConfigurationDigest(plain)}],['oauth',{config:oauth,configurationDigest:remoteMcpConfigurationDigest(oauth)}]])])),
        captureOAuthGrant:grant,captureConnectionGrant:grant,authorizeControl:(_b,_o,a)=>a,
        captureRemovalGrant:binding=>{assert.equal(binding.server,'oauth');assert.equal(binding.configurationDigest,remoteMcpConfigurationDigest(oauth));assert.ok(binding.credentialID);removalGrants++;return grant();},
        authorizeCall:(invocation,binding,action)=>Effect.gen(function*(){assert.ok(sessions.has(invocation.nativeContext.sessionID));observed.push({directory:binding.directory,acquisitionID:binding.acquisitionID,origin:invocation.provenance.id});const request={operation:'tool.execute',sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,
            input:{toolID:invocation.toolID,nativeToolID:invocation.nativeToolID,callID:invocation.nativeContext.id,provenance:invocation.provenance,input:invocation.input}};
          const before=calls.length;
          const expectRefusal=async(work,code)=>{await assert.rejects(work,error=>error.code===code);mutationNegatives.push(code);assert.equal(calls.length,before);};
          yield* Effect.promise(()=>expectRefusal(()=>bridge.recheck(invocation.existingPermit,{...request,input:{...request.input,input:{value:'changed'}}}),'native_permit_lineage_mismatch'));
          const stale=yield* Effect.promise(()=>bridge.authorize(request));yield* Effect.promise(()=>bridge.release(stale));
          yield* Effect.promise(()=>expectRefusal(()=>bridge.recheck(stale,request),'native_permit_invalid'));
          yield* Effect.promise(async()=>{
            pausedRead={entered:Promise.withResolvers(),release:Promise.withResolvers()};
            const suspended=bridge.recheck(invocation.existingPermit,request);void suspended.catch(()=>{});
            try{await pausedRead.entered.promise;revokedAdmission=true;pausedRead.release.resolve();
              await expectRefusal(()=>suspended,'fixture_access_revoked');}
            finally{pausedRead.release.resolve();pausedRead=undefined;revokedAdmission=false;}
          });
          return yield* routing.withControl(invocation,action);
        }),
        executeOwnedFallback:()=>Effect.die(new Error('unexpected non-MCP tool')),
        withCredentialMutation:(binding,action)=>Effect.gen(function*(){
          assert.equal(binding.kind,'mcp');assert.equal(binding.valueType,'oauth');assert.ok(binding.requestedFingerprint);
          if(binding.credentialID){const current=yield* originalCredentials.get(binding.credentialID);assert.equal(remoteMcpDigest(current),binding.expectedFingerprint);credentialIDs.add(binding.credentialID);}
          mutations.push({operation:binding.operation,integrationID:binding.integrationID,credentialID:binding.credentialID});
          if(binding.operation==='remove'&&changeDuringRemoval)yield* originalCredentials.update(binding.credentialID,{label:'changed while queued'});
          return yield* action;
        })});
      const sessionContext=createNativeSessionContext({origin:{kind:'plugin',id:'devryan.harness-context',manifestDigest:'c'.repeat(64),capabilities:['control']},executeOwned:owned.executeOwned,
        rpc:privateRpc});
      const gates=createAdmissionGates({bridge,nativePlugins,executeOwned:sessionContext.withPrimaryToolExecution(owned.executeOwned)});await gates.controls.openStartup();
      const document=new ConfigSchema.Document({type:'document',info:Schema.decodeUnknownSync(ConfigSchema.Info)({snapshots:false,warming:false,plugins:[],update:'disable'})});
      let duplicateConfig=false;
      const duplicateDocument=new ConfigSchema.Document({type:'document',info:Schema.decodeUnknownSync(ConfigSchema.Info)({mcp:{servers:{plain,oauth}},snapshots:false,warming:false,plugins:[],update:'disable'})});
      const replacements=[...configurationOverrides({}),Config.node.replace(Layer.succeed(Config.Service,{entries:()=>Effect.succeed([duplicateConfig?duplicateDocument:document]),compatibility:()=>Effect.succeed({claude:[],agents:[]}),changes:()=>Stream.empty})),
        Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,cache:process.env.XDG_CACHE_HOME,tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),
        ...gates.overrides,...owned.overrides,
        Bus.node.replace(Bus.node.mapLayer(layer=>Layer.effect(Bus.Service,Effect.gen(function*(){nativeBus=yield* Bus.Service;return nativeBus;})).pipe(Layer.provide(layer)))),
        SessionStore.node.replace(SessionStore.node.mapLayer(layer=>Layer.effect(SessionStore.Service,Effect.gen(function*(){const inner=yield* SessionStore.Service;runStore=Effect.runPromiseWith(Context.add(yield* Effect.context(),SessionStore.Service,inner));return inner;})).pipe(Layer.provide(layer)))) ,
        Credential.node.replace(Credential.node.mapLayer(layer=>Layer.effect(Credential.Service,Effect.gen(function*(){originalCredentials=yield* Credential.Service;composedCredentials=owned.decorateCredential(originalCredentials);return composedCredentials;})).pipe(Layer.provide(layer)))),
        Integration.node.replace(Integration.node.mapLayer(layer=>Layer.effect(Integration.Service,Effect.gen(function*(){const inner=yield* Integration.Service;const location=yield* Location.Service;originals.set(location.directory,inner);return owned.decorateIntegration(inner,location);})).pipe(Layer.provide(layer)))),
        Permission.node.replace(Permission.node.mapLayer(layer=>Layer.effect(Permission.Service,Effect.gen(function*(){const inner=yield* Permission.Service;return {...inner,assert:input=>{permissions.push(input.action);return inner.assert(input);}};})).pipe(Layer.provide(layer)))),
        LocationActivity.node.replace(LocationActivity.node.mapLayer(layer=>Layer.effect(LocationActivity.Service,Effect.gen(function*(){const inner=yield* LocationActivity.Service;map=yield* LocationServiceMap.Service;return inner;})).pipe(Layer.provide(layer))))];
      const { Stream }=await import('effect');
      const rows=[], closingServices=[], reopened=[], originals=new Map(), pending=[];
      try{
        await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
          const api=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides:replacements});
          const at=(directory,action)=>action.pipe(Effect.provide(LocationServiceMap.Service.get({directory})),Effect.provideService(LocationServiceMap.Service,map));
          const captures=[];
          for(const directory of directories){
            const session=yield* api.sessions.create({location:{directory},permissions:[{action:'*',resource:'*',effect:'allow'}]});sessions.add(session.id);sessionRows.set(session.id,{id:session.id,directory});
            yield* api.agent.list({location:{directory}});
            const captured=yield* at(directory,Effect.gen(function*(){
              const plugin=yield* Plugin.Service;yield* plugin.awaitActivation;
              const mcp=yield* Mcp.Service,mcpt=yield* McpTool.Service,tools=yield* Tool.Service,integration=yield* Integration.Service;
              yield* mcpt.flush;
              const catalog=yield* Effect.promise(()=>wait(()=>Effect.runPromise(tools.list()),rows=>rows.some(tool=>tool.id==='plain_lookup'),'native MCP catalog did not register plain_lookup'));assert.ok(catalog.some(tool=>tool.id==='plain_lookup'));
              // The real compatibility snapshot is empty. A later original ConfigMcpPlugin
              // pass containing the identical reviewed servers must not replace/collide.
              duplicateConfig=true;
              const beforeNames=(yield* mcp.servers()).map(row=>row.name);
              yield* ConfigMcpPlugin.register(Stream.empty).pipe(Effect.provideService(RegistrationOriginRef,nativePlugins.get('opencode.config.mcp')));
              assert.deepEqual((yield* mcp.servers()).map(row=>row.name),beforeNames);
              assert.equal((yield* tools.list()).filter(tool=>tool.id==='plain_lookup').length,1);
              duplicateConfig=false;
              const view=yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);
              const index=captures.length,userMessageID='msg_user'+index,assistantMessageID='msg_assistant'+index,callID='call_'+index;
              const model={providerID:'openai',id:'fixture',variant:'xhigh'};
              const runner=yield* Effect.promise(()=>bridge.authorize({operation:'runner.drain',sessionID:session.id}));
              const bus=nativeBus;
              yield* bus.publish(SessionEvent.InboxEnqueued,{sessionID:session.id,inboxID:userMessageID,item:{type:'user',delivery:'queue',payload:{text:'Owned MCP objective'}}});
              yield* bus.publish(SessionEvent.InboxDelivered,{sessionID:session.id,inboxID:userMessageID});
              yield* bus.publish(SessionEvent.Step.Started,{sessionID:session.id,assistantMessageID,agent:'orchestrator',model,started:Date.now()});
              yield* bus.publish(SessionEvent.Tool.Input.Started,{sessionID:session.id,assistantMessageID,id:callID,name:'plain_lookup'});
              yield* bus.publish(SessionEvent.Tool.Input.Ended,{sessionID:session.id,assistantMessageID,id:callID,text:JSON.stringify({value:'fixture'})});
              yield* bus.publish(SessionEvent.Tool.Called,{sessionID:session.id,assistantMessageID,id:callID,input:{value:'fixture'},executed:false});
              if(index===1){
                yield* Effect.promise(()=>primary.admit({sessionID:session.id,directory,primary:true,executionGeneration:2,body:{messageID:userMessageID,agent:'orchestrator',model:{providerID:'openai',modelID:'fixture'},variant:'xhigh'}}));
                yield* Effect.promise(()=>primary.plugin({action:'step',sessionID:session.id,userMessageID,assistantMessageID,instanceID:'real-mcp-primary'}));
                assert.equal((yield* Effect.promise(()=>primary.readRecord(session.id))).stepID,assistantMessageID);
              }
              const invoke=(snapshot,id)=>snapshot.execute({sessionID:session.id,messageID:assistantMessageID,agent:'orchestrator',call:{type:'tool-call',id,name:'plain_lookup',input:{value:'fixture'}}});
              const result=yield* invoke(view,callID).pipe(Effect.provideService(OperationPermitRef,runner));
              yield* Effect.promise(()=>bridge.release(runner));assert.ok(result.content.some(part=>part.type==='text'&&part.text==='owned-loopback-result'));
              const infos=yield* integration.list();const info=infos.find(item=>item.metadata?.source==='mcp'&&item.name==='oauth');assert.ok(info);
              return {directory,session,view,invoke,mcp,integration,info,location:yield* Location.Service,credentials:composedCredentials,original:originals.get(directory)};
            }));captures.push(captured);
          }
          // Real native OAuth callback -> original Integration auto commit.
          const first=captures[0],method=first.info.methods.find(method=>method.type==='oauth');assert.ok(method);
          const attempt=yield* first.integration.oauth.connect({integrationID:first.info.id,methodID:method.id});
          yield* Effect.promise(()=>fetch(attempt.url));
          yield* Effect.promise(()=>wait(()=>Effect.runPromise(first.integration.oauth.status({integrationID:first.info.id,attemptID:attempt.attemptID})),value=>value.status==='complete','native OAuth did not commit'));
          const before=yield* originalCredentials.list(first.info.id);assert.equal(before.length,1);
          // Expire only this synthetic credential; actual native reconnect must
          // refresh its SAME ID through the production decorator and queue seam.
          yield* originalCredentials.update(before[0].id,{value:{...before[0].value,expires:Date.now()-1000}});
          rejectAccess=true;yield* first.mcp.disconnect('oauth');yield* first.mcp.connect('oauth');
          const after=yield* originalCredentials.list(first.info.id);assert.equal(after.length,1);assert.equal(after[0].id,before[0].id);assert.ok(refreshes>0);
          assert.ok(mutations.some(row=>row.operation==='update'&&row.credentialID===before[0].id));
          for(const captured of captures)rows.push({directory:captured.directory,acquisitionID:observed.find(row=>row.directory===captured.directory).acquisitionID});
          // Exact owned removal cannot use a stale value after waiting in the
          // shared mutation queue. The native store remains authoritative.
          changeDuringRemoval=true;
          const changed=yield* Effect.exit(owned.removeCredentialOwned(first.original,first.location,first.credentials,before[0].id));
          assert.equal(changed._tag,'Failure');assert.match(String(Cause.squash(changed.cause)),/native_credential_changed/);
          assert.equal((yield* originalCredentials.get(before[0].id)).label,'changed while queued');
          changeDuringRemoval=false;
          yield* owned.removeCredentialOwned(first.original,first.location,first.credentials,before[0].id);
          assert.equal(yield* originalCredentials.get(before[0].id),undefined);assert.equal(removalGrants,2);
          yield* LocationServiceMap.reload().pipe(Effect.provideService(LocationServiceMap.Service,map));
          for(const old of captures){
            yield* api.agent.list({location:{directory:old.directory}});
            yield* at(old.directory,Effect.gen(function*(){const plugin=yield* Plugin.Service;yield* plugin.awaitActivation;const mcpt=yield* McpTool.Service;yield* mcpt.flush;closingServices.push(yield* Mcp.Service);reopened.push({directory:old.directory,integration:yield* Integration.Service});}));
            const exit=yield* Effect.exit(old.invoke(old.view,'expired_'+old.directory));assert.equal(exit._tag,'Failure');
            assert.match(String(Cause.squash(exit.cause)),/native_tool_location_expired/);
            const oldExit=yield* Effect.exit(old.mcp.tools());assert.equal(oldExit._tag,'Failure');assert.match(String(Cause.squash(oldExit.cause)),/registration_expired/);
            const staleRemoval=yield* Effect.exit(owned.removeCredentialOwned(old.original,old.location,old.credentials,before[0].id));
            assert.equal(staleRemoval._tag,'Failure');assert.match(String(Cause.squash(staleRemoval.cause)),/native_mcp_registration_expired/);assert.equal(removalGrants,2);
          }
          // Actual pending native attempts belong to one acquisition. Closing
          // one location cancels only its attempt before the other Scope closes.
          for(const location of reopened){
            const info=(yield* location.integration.list()).find(info=>info.metadata?.source==='mcp'&&info.name==='oauth');
            const method=info.methods.find(method=>method.type==='oauth');
            const attempt=yield* location.integration.oauth.connect({integrationID:info.id,methodID:method.id});
            pending.push({directory:location.directory,integrationID:info.id,attemptID:attempt.attemptID});
          }
          yield* owned.closeLocation(pending[0].directory);
          const removed=yield* Effect.exit(originals.get(pending[0].directory).oauth.status(pending[0]));
          assert.equal(removed._tag,'Failure');assert.equal(Cause.squash(removed.cause)._tag,'Integration.AttemptNotFound');
          assert.equal((yield* originals.get(pending[1].directory).oauth.status(pending[1])).status,'pending');
          assert.equal(calls.filter(row=>row.endpoint==='/plain').length,2);assert.deepEqual(permissions.filter(action=>action==='plain_lookup'),['plain_lookup','plain_lookup']);
          assert.equal(controlCalls.filter(method=>method.endsWith('control-begin')).length,2);assert.deepEqual(primaryObservations.map(row=>row.tracked),[false,false,true,true]);assert.equal(mutationNegatives.length,6);assert.equal(observed.length,2);for(const row of observed)assert.equal(row.origin,origin.id);
          // Closing actual SDK Scope below invalidates old services before any
          // awaited cleanup. No current binding or callback may survive.
        }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
        for(const service of closingServices){const exit=await Effect.runPromise(Effect.exit(service.tools()));assert.equal(exit._tag,'Failure');assert.match(String(Cause.squash(exit.cause)),/registration_expired/);}
        assert.ok(rows[0].acquisitionID!==rows[1].acquisitionID);
        process.stdout.write(JSON.stringify({locations:rows.map(row=>row.directory),calls:calls.length,permissionChecks:permissions.filter(action=>action==='plain_lookup').length,
          refreshes,createCount:mutations.filter(row=>row.operation==='create').length,selectedCredentialCount:credentialIDs.size,
          ordinaryAndAdmittedPrimary:true,mutationNegatives:mutationNegatives.length,oldBindingsRefused:true,removalConflictRefused:true,removalGrants,elicitation:'global-or-ambiguous-native-requests-refused'}));
      }finally{await primary.drain();await privateHost.stop();await routing.close();admissionOwner.dispose();for(const stream of streams)stream.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
    `;
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: repository,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', DEVRYAN_GRAPH_DIRECTORIES: JSON.stringify(directories) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child?.kill('SIGKILL'), 45_000);
    try {
      const stdout = child.stdout, stderr = child.stderr;
      if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw new Error('Owned pipes required');
      const [output, errors, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(errors.slice(0, 8192));
      expect(exitCode).toBe(0);
      // The pinned SDK warns for configured client information without an issuer
      // stamp. Keep this exact compatibility observation visible; other stderr fails.
      const issuerWarning = "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or provider not round-tripping the value). SEP-2352 isolation is inactive for this read; ensure your provider round-trips the issuer field.";
      const warnings = errors.trim().split('\n');
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) expect(warning).toBe(issuerWarning);
      expect(output.startsWith('{')).toBe(true);
      const proof: { locations: string[]; calls: number; permissionChecks: number; refreshes: number; createCount: number;
        selectedCredentialCount: number; ordinaryAndAdmittedPrimary:boolean;mutationNegatives:number;oldBindingsRefused: boolean; removalConflictRefused:boolean;removalGrants:number;elicitation: string } = JSON.parse(output);
      expect(proof.locations).toEqual(directories); expect(proof.calls).toBeGreaterThanOrEqual(2);
      expect(proof.permissionChecks).toBe(2); expect(proof.refreshes).toBeGreaterThan(0); expect(proof.createCount).toBe(1);
      expect(proof.selectedCredentialCount).toBe(1); expect(proof.ordinaryAndAdmittedPrimary).toBe(true);expect(proof.mutationNegatives).toBe(6);expect(proof.oldBindingsRefused).toBe(true);
      expect(proof.removalConflictRefused).toBe(true);expect(proof.removalGrants).toBe(2);
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 50_000);
