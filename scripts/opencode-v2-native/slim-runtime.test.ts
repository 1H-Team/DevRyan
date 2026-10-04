import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {renderReviewedPonytailInstructions} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-ponytail-instructions.js';
import {rewriteReviewedSlimServer} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';

for(const controllerComposition of [false,true])test((controllerComposition?'controller composition: ':'')+'composed pinned Slim runtime preserves two location catalogs across tool reload and disposes its native scope', async () => {
  const base = path.resolve(import.meta.dirname, '../../.cache/v2-validation');
  const root = await fs.mkdtemp(path.join(base, 'native-slim-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const home = path.join(root, 'home'), tmp = path.join(home, 'tmp'), config = path.join(home, 'config');
    await fs.mkdir(tmp, { recursive: true }); await fs.mkdir(config);
    await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}');
    await fs.writeFile(path.join(config, 'oh-my-opencode-slim.json'), JSON.stringify({ autoUpdate: false, companion: { enabled: false },
      backgroundJobs: { orchestratorWake: { enabled: false } }, agents: { builder: { model: 'sim/m1', variant: 'high' } } }));
    const directories = [path.join(root, 'one'), path.join(root, 'two'),path.join(root,'inactive')];
    await Promise.all(directories.map(directory => fs.mkdir(directory)));
    const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
    const sdk = new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js', import.meta.url).href;
    const input = new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js', import.meta.url);
    const transformed = rewriteReviewedSlimServer(await fs.readFile(input));
    const reviewedEntry = path.join(root, 'reviewed-slim.mjs');
    await fs.writeFile(reviewedEntry, transformed.contents);
    const slim = pathToFileURL(reviewedEntry).href;
    const source = `
      import { Effect, Fiber, Layer, Logger } from 'effect';
      import { Global } from '@opencode/util/global';
      import { Tool } from '@opencode/core/tool';
      import { Plugin } from '@opencode/core/plugin';
      import { Command } from '@opencode/core/command';
      import { PluginHooks } from '@opencode/core/plugin/hooks';
      import { Message } from '@opencode/ai/schema/messages';
      const { OpenCode } = await import(${JSON.stringify(sdk)});
      const { default: packagePlugin, bindReviewedSlimConfiguration,bindReviewedSlimHost,createWebfetchTool,ast_grep_search,ast_grep_replace,createDeepworkCommandHook,createLoopCommandHook,createReflectCommandHook } = await import(${JSON.stringify(slim)});
      const { createNativeSlimRuntime:createRuntime,currentNativeSlimHookAuthority } = await import(${JSON.stringify(`${host}native-slim-runtime.ts`)});
      const { createControllerInterview } = await import(${JSON.stringify(`${host}controller-interview.ts`)});
      const { createControllerSlim } = await import(${JSON.stringify(`${host}controller-slim.ts`)});
      const controllerComposition=${JSON.stringify(controllerComposition)};
      const {createNativeSlimContextOwner}=await import(${JSON.stringify(`${host}native-slim-context-owner.js`)});
      const {createManagedTaskScheduler}=await import(${JSON.stringify(new URL('../../packages/orchestration-runtime/index.js', import.meta.url).href)});
      const {createPrimaryRecoveryController}=await import(${JSON.stringify(new URL('../../packages/harness-runtime/index.js', import.meta.url).href)});
      const contextRpc=[];let actualBoardOwner,insertionTamper,expectedRetryAttempt;
      const createNativeSlimRuntime=options=>{
       if(!controllerComposition)return createRuntime(options);
       const owner=directory=>options.forDirectory(options.snapshot.locations.find(value=>value.directory===directory));
       return createControllerSlim({...options,rpc:async(method,input)=>{
        const hostOwner=owner(input.directory),authority=currentNativeSlimHookAuthority();
        if(!authority||authority.permit.token!==input.permit?.token||authority.signal.aborted)throw new Error('controller_actual_hook_grant_lost');
        if(method==='native.slim.hook'){
         await hostOwner.assertContext(input);
         if(input.action==='message')return hostOwner.readMessage({directory:input.directory,sessionID:input.sessionID,messageID:input.requestedMessageID});
         if(input.action==='ponytail')return hostOwner.ponytail.contextInstructions(input.directory);return null;
        }
        if(method==='native.slim.context'){
         if(JSON.stringify(input).includes('OWNED_MEDIA_SENTINEL'))throw new Error('media_payload_in_context_rpc');contextRpc.push(input);
         if(input.action==='retry'&&(!input.attempt||JSON.stringify(input.attempt)!==JSON.stringify(expectedRetryAttempt)||JSON.stringify(authority.attempt)!==JSON.stringify(expectedRetryAttempt)))throw new Error('native_retry_attempt_bridge_lost');
         if(input.action==='transform'){if(actualBoardOwner){const result=await actualBoardOwner.transformMessages(input);if(insertionTamper){const insertion=result.presentationInsertions[0],message=result.messages[insertion.index];if(insertionTamper==='base')insertion.baseKey='forged';else if(insertionTamper==='index')insertion.index=0;else if(insertionTamper==='role')message.info.role='assistant';else if(insertionTamper==='nontext')message.parts[0]={type:'media',data:'FORGED'};else if(insertionTamper==='metadata')message.parts[0].metadata={};else if(insertionTamper==='order')result.messages.reverse();}return result;}if(projectionTamper){const messages=structuredClone(input.messages);if(projectionTamper==='order')messages.reverse();else if(projectionTamper==='key')messages[1].devryanContextKey=messages[0].devryanContextKey;else if(projectionTamper==='identity')messages[1].info.id='forged-native-id';else if(projectionTamper==='placeholder')messages[1].parts.reverse();else if(projectionTamper==='missing')messages[1].parts.pop();return {messages,presentationInsertions:[]};}if(transformRefused)throw new Error('owned_transform_refused');return {messages:input.messages.map((message,index)=>index?message:{...message,parts:[...message.parts,{type:'text',text:'ACTUAL OWNED TASKBOARD'}]}),presentationInsertions:[]};}return {decision:{retry:false}};
        }
        if(method==='native.slim.path'){escapedRead=authority.assertToolRead;if(input.action==='stat'){if(pathRefused)throw new Error('owned_path_refused');return {kind:'file'};}if(input.action==='assert')return null;throw new Error('unexpected_path_operation');}
        if(method==='native.slim.accepted-command')return null;throw new Error('unexpected_controller_rpc');
       },webfetchBinaryDirectory:directory=>owner(directory).webfetch.binaryDirectory,webfetchOwnersFor:(invocation,context)=>owner(invocation.location.directory).webfetch.ownersFor(invocation,context),commands:commandOwners,applyPonytailCommand:()=>Effect.void,
       interviewForDirectory:directory=>({runtime:{},service:{getActiveInterviewId:createControllerInterview({controllerInstanceID:'fixture',isCurrent:()=>true,rpc:async(method,input,rpcOptions)=>{
        if(method!=='native.slim.interview.active')throw new Error('unexpected_interview_rpc');
        if(interviewRefused)throw new Error('accepted_interview_command_required');
        if(activeReadSuspended){if(!rpcOptions?.signal)throw new Error('interview_active_read_signal_missing');startActiveRead();await new Promise((_resolve,reject)=>{rpcOptions.signal.addEventListener('abort',()=>{activeReadCancelled=true;reject(rpcOptions.signal.reason)},{once:true});});}
        return null;
       }}).forDirectory(directory).service.getActiveInterviewId,handleCommandExecuteBefore:async()=>{throw new Error('unexpected_interview_command')},handleEvent:async input=>owner(directory).interviewBridge.handleEvent(input.event)},submitCommand:async()=>{throw new Error('unexpected_raw_command')},assertAcceptedCommand:async()=>{},assertCurrent:async()=>{},dispose:async()=>{}}),
       observePrompt:(authority,input,output)=>owner(authority.directory).observePrompt(input,output),observeLifecycle:(directory,event)=>owner(directory).observeLifecycle(event),transformImages:async()=>{},disposeLocation:directory=>owner(directory).dispose(),log:(directory,message)=>owner(directory).log(message)});
      };
      const { nativeSlimCommandBehaviorsPlugin,reviewedSlimCommandDeclarations } = await import(${JSON.stringify(`${host}native-slim-commands.ts`)});
      const { trustedPluginOverride } = await import(${JSON.stringify(`${host}trusted-plugins.ts`)});
      const { createAdmissionGates } = await import(${JSON.stringify(`${host}admission-gates.ts`)});
      const {currentNativeAttemptIdentity}=await import(${JSON.stringify(`${host}native-observation.ts`)});
      const { OperationPermitRef } = await import(${JSON.stringify(`${host}native-admission-contract.ts`)});
      const { configurationOverridesForSnapshot } = await import(${JSON.stringify(`${host}configuration.ts`)});
      const networkCalls=[];globalThis.fetch = async(input)=>{networkCalls.push({url:String(input instanceof Request?input.url:input),stack:new Error().stack});throw new Error('fixture_network_forbidden')};
      const dirs = JSON.parse(process.env.DEVRYAN_GRAPH_DIRECTORIES);
      const snapshot = {schema:1,revision:1,digest:'b'.repeat(64),registrationManifestDigest:'c'.repeat(64),locations:dirs.map((directory,index)=>({
        directory,...index===2?{activeRegistrationIDs:[]}: {},configuration:{agents:{builder:{model:{providerID:'sim',model:'m1',variant:index?'medium':'high'},system:'saved-'+index}},default_agent:'builder',snapshots:false,warming:false,plugins:[],commands:{}},skills:[],aliases:[],instructions:[],textReferences:[],compatibility:{legacy:{},agents:{builder:{model:"sim/m1"}},mcp:{},commands:{},slim:{mergedConfig:{autoUpdate:false,companion:{enabled:false},backgroundJobs:{orchestratorWake:{enabled:false}},webfetch:{model:'sim/m1'},agents:{builder:{model:'sim/m1',variant:index?'medium':'high'}}}}}
      }))};
      const origin = {kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','network','process']};
      const commandEvents=[];let commandRefused=false;const lifecycleEvents=[];const disposals=[];const hookAuthorities=[];const controlEvents=[];let releaseSecondary;let startedSecondary;let secondarySettled=false;const secondaryStarted=new Promise(resolve=>startedSecondary=resolve);let contextRefused=false;let activeReadSuspended=false,activeReadCancelled=false,startActiveRead;const activeReadStarted=new Promise(resolve=>startActiveRead=resolve);let transformRefused=false;let projectionTamper;let pathRefused=false;let interviewRefused=false;let escapedRead;const readProofs=[];
      const originals=await import(${JSON.stringify(slim)});
      let activeCommandControls;const commandOwners={assertCommand:input=>Effect.gen(function*(){const proof=yield* activeCommandControls.assertReviewedCommand(input);commandEvents.push({event:"authority",name:input.name,directory:input.directory,token:proof.permit.token});yield* Effect.sync(()=>{commandEvents.push({event:'assert',name:input.name,directory:input.directory});if(commandRefused)throw new Error('command_revoked')});}),executeCommand:input=>Effect.sync(()=>commandEvents.push({event:'execute',...input}))};
      const runtime=createNativeSlimRuntime({snapshot,originals,origin,withControl:(_invocation,execute)=>Effect.sync(()=>controlEvents.push('control-start')).pipe(Effect.andThen(execute),Effect.ensuring(Effect.sync(()=>{controlEvents.push('control-finish');if(!secondarySettled)throw new Error('control_before_actual_settlement')}))),ponytailCommand:${JSON.stringify((await renderReviewedPonytailInstructions()).command)},executeOwned:()=>Effect.die(new Error('downstream_not_expected')),forDirectory:location=>({
       log:()=>{},commands:commandOwners,webfetch:{binaryDirectory:process.env.OPENCODE_CONFIG_DIR+'/binary',ownersFor:async(invocation,context)=>({assertCurrent:async()=>{if(invocation.existingPermit.token!=='e'.repeat(64))throw new Error('original_invocation_lost')},cache:originals.createReviewedWebfetchCache(),fetch:async()=>new Response(Array.from({length:40},(_,i)=>'owned'+i).join(' '),{headers:{'content-type':'text/plain'}}),loadJSDOM:async()=>{throw new Error('fixture_html_not_expected')},saveBinary:async()=>{throw new Error('fixture_binary_not_expected')},secondary:async request=>{startedSecondary();await new Promise(resolve=>releaseSecondary=resolve);secondarySettled=true;request.signal.throwIfAborted();return 'owned result'}})},
       ponytail:{contextInstructions:async directory=>'EXACT PONYTAIL '+directory,applyCommand:()=>Effect.void},
       assertContext:async input=>{const authority=currentNativeSlimHookAuthority();if(!authority||authority.directory!==input.directory||authority.sessionID!==input.sessionID)throw new Error('actual_hook_authority_missing');hookAuthorities.push({phase:authority.phase,token:authority.permit.token,directory:authority.directory});if(contextRefused)throw new Error('context_revoked')},readMessage:async()=>({parts:[]}),observeLifecycle:async event=>{lifecycleEvents.push({directory:location.directory,event})},observePrompt:async()=>{},retry:async()=>{const authority=currentNativeSlimHookAuthority();if(!authority?.attempt||JSON.stringify(authority.attempt)!==JSON.stringify(expectedRetryAttempt))throw new Error('native_retry_attempt_hook_lost')},
       beforePaths:async()=>{const authority=currentNativeSlimHookAuthority();if(authority?.assertToolRead){escapedRead=authority.assertToolRead;await authority.assertToolRead('owned-target');}},transformMessages:async()=>{},dispose:async()=>{disposals.push(location.directory)},
       interviewBridge:{registerCommand:()=>{},handleContext:async()=>{if(interviewRefused)throw new Error('accepted_interview_command_required')},handleEvent:async()=>{},dispose:async()=>{}}})});
      const reviewed=runtime.plugin,commandBehavior=runtime.commands;
      const lifetimeInvocation={toolID:'webfetch',provenance:origin,location:{directory:dirs[0]},input:{url:'http://fixture.invalid/text',prompt:'exact task',prefer_llms_txt:'never'},existingPermit:{token:'e'.repeat(64),revision:0,sessionID:'ses_lifetime'},recheckPermit:()=>Effect.void,nativePermissionAssert:()=>Effect.void,executeNative:()=>Effect.die(new Error('unsafe_adapter_executed')),nativeContext:{sessionID:'ses_lifetime',messageID:'msg_lifetime',id:'call_lifetime',agent:'builder',progress:update=>Effect.sync(()=>controlEvents.push('progress'))}};
      const fiber=Effect.runFork(runtime.executeOwned(lifetimeInvocation));
      await secondaryStarted;if(!controlEvents.includes('progress'))throw new Error('progress_was_buffered');
      let interruptionFinished=false;const interruption=Effect.runPromise(Fiber.interrupt(fiber)).then(()=>{interruptionFinished=true});
      await Bun.sleep(10);if(interruptionFinished||controlEvents.includes('control-finish'))throw new Error('cancellation_did_not_drain');
      releaseSecondary();await interruption;if(controlEvents.at(-1)!=='control-finish')throw new Error('control_never_settled');

      const commandOrigin={kind:'plugin',id:'devryan.slim-commands',manifestDigest:'d'.repeat(64),capabilities:['control']};
      const reviewedBehaviorCommands=Object.entries(runtime.commandDeclarations).map(([name,definition])=>({origin:commandOrigin,name,definition}));
      const rows=[];
      for(const directory of dirs){
        let capturedTools,capturedPlugins,capturedCommands,capturedHooks; const calls=[];
        const bridge={beginCommand:async input=>{if(!reviewedBehaviorCommands.some(value=>value.name===input.name&&JSON.stringify(value.origin)===JSON.stringify(input.origin)))throw new Error('unreviewed_command');return 'e'.repeat(64);},awaitReady:async()=>{},authorize:async request=>({token:'d'.repeat(64),revision:0,sessionID:request.sessionID}),recheck:async()=>{},release:async()=>{},
          sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
        const gates=createAdmissionGates({bridge,sessionHooks:(inner,location)=>runtime.decorateHooks(inner,location,{assertToolRead:(event,target)=>Effect.sync(()=>{readProofs.push({event,target})})}),reviewedBehaviorCommands,reviewedConfigurationForDirectory:directory=>snapshot.locations.find(value=>value.directory===directory)?.configuration,nativePlugins:new Map(),executeOwned:call=>{calls.push({toolID:call.toolID,directory:call.location.directory,origin:call.provenance});return Effect.succeed({content:'owned-leaf'});}});
        activeCommandControls=gates.controls;await gates.controls.openStartup();
        const capture=Plugin.node.replace(Plugin.node.mapLayer(layer=>Layer.effect(Plugin.Service,Effect.gen(function*(){const inner=yield* Plugin.Service;capturedTools=yield* Tool.Service;capturedCommands=yield* Command.Service;capturedHooks=yield* PluginHooks.Service;capturedPlugins=inner;return inner;})).pipe(Layer.provide(layer))));
        await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
          const api=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},
            {overrides:[...configurationOverridesForSnapshot(snapshot),Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.OPENCODE_CONFIG_DIR,data:process.env.HOME+'/data',state:process.env.HOME+'/state',cache:process.env.HOME+'/cache',tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),
            trustedPluginOverride({plugins:[{plugin:reviewed,origin},{plugin:commandBehavior,origin:commandOrigin},{plugin:runtime.ponytail,origin:{kind:'plugin',id:'devryan.ponytail',manifestDigest:'1'.repeat(64),capabilities:['control']}},{plugin:runtime.lifecycle,origin:{kind:'plugin',id:'devryan.slim-lifecycle',manifestDigest:'2'.repeat(64),capabilities:['control']}}],additionalOrigins:[],nativePlugins:new Map()}),...gates.overrides,capture]});
          yield* api.agent.list({location:{directory}});
          if(!capturedPlugins||!capturedTools) throw new Error('native_catalog_missing');
          yield* capturedPlugins.awaitActivation;
          const agents=yield* api.agent.list({location:{directory}});
          if(directory===dirs[2]){
           const lists=[];for(let index=0;index<2;index++){if(index)yield* capturedTools.reload();const catalog=yield* capturedTools.list();lists.push(catalog.map(tool=>tool.id));}
           const inactiveCommands=yield* capturedCommands.list();if(inactiveCommands.some(command=>['deepwork','loop','reflect','interview','ponytail'].includes(command.name)))throw new Error('inactive_plugin_command_registered');
           if(lists.some(list=>list.some(tool=>['ast_grep_search','ast_grep_replace'].includes(tool))))throw new Error('inactive_plugin_tool_registered');
           rows.push({directory,agents:agents.data.map(agent=>({id:agent.id,model:agent.model,system:agent.system})),lists,calls});return;
          }
          if(!capturedHooks)throw new Error('native_hooks_missing');
          const contextSession=yield* api.sessions.create({location:{directory},agent:'builder'});
          const contextEvent={sessionID:contextSession.id,agent:'orchestrator',model:{providerID:'sim',id:'m1'},system:[{type:'text',text:'FIRST'},{type:'text',text:'SECOND'}],tools:{},options:{},messages:[{id:'msg_owneduser',role:'user',agent:'orchestrator',sessionID:contextSession.id,content:[{type:'text',text:'Exact objective'},...controllerComposition?[{type:'media',data:'OWNED_MEDIA_SENTINEL',mediaType:'image/png'}]:[]]}]};
          yield* Effect.gen(function*(){
           expectedRetryAttempt=yield* currentNativeAttemptIdentity;
           if(!expectedRetryAttempt)throw new Error('native_retry_actual_span_required');
           const retry={sessionID:contextSession.id,agent:'builder',model:{providerID:'sim',id:'m1'},error:{statusCode:429},attempt:1,decision:{retry:true,delay:100}};
           const result=yield* capturedHooks.trigger('session','retry',retry).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
           if(controllerComposition&&result.decision.retry!==false)throw new Error('native_retry_decision_lost');
          }).pipe(Effect.withSpan('SessionStep.attempt'));
          const transformed=yield* capturedHooks.trigger('session','context',contextEvent).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
          if(!transformed.system[0]?.text.startsWith('FIRST')||!transformed.system[0]?.text.includes('SECOND')||!transformed.system.some(part=>part.text==='EXACT PONYTAIL '+directory)||transformed.messages[0].content.length<2)throw new Error('original_context_or_ponytail_missing:'+JSON.stringify([transformed.system[0]?.text.startsWith('FIRST'),transformed.system[0]?.text.includes('SECOND'),transformed.system.some(part=>part.text==='EXACT PONYTAIL '+directory),transformed.messages[0].content.length]));
          if(controllerComposition&&!transformed.messages[0].content.some(part=>part.data==='OWNED_MEDIA_SENTINEL'))throw new Error('native_media_reference_lost');
          if(controllerComposition&&!transformed.messages[0].content.some(part=>part.text==='ACTUAL OWNED TASKBOARD'))throw new Error('in_place_taskboard_changes_lost');
          if(controllerComposition){
           const toolResult=Message.tool({id:'call_real_result',name:'read',result:{type:'text',value:'ACTUAL RESULT'}});
           const secondResult=Message.tool({id:'call_second_result',name:'read',result:{type:'text',value:'SECOND RESULT'}});
           if(Object.hasOwn(toolResult,'id'))throw new Error('native_tool_result_unexpected_id');
           const actualResultEvent={...contextEvent,system:[],messages:[contextEvent.messages[0],{...toolResult,content:[...toolResult.content,...secondResult.content]}]};
           const resultContext=yield* capturedHooks.trigger('session','context',actualResultEvent).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
           const restored=resultContext.messages[1];
           if(restored.role!=='tool'||Object.hasOwn(restored,'id')||restored.content.length!==2||restored.content[0]!==toolResult.content[0]||restored.content[1]!==secondResult.content[0]||Object.hasOwn(restored,'devryanContextKey'))throw new Error('native_tool_result_identity_or_content_lost');
           for(const mode of ['order','key','identity','placeholder','missing']){
            projectionTamper=mode;
            const denied=yield* capturedHooks.trigger('session','context',{...actualResultEvent,messages:[contextEvent.messages[0],{...toolResult,content:[...toolResult.content,...secondResult.content]}]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
            projectionTamper=undefined;if(denied._tag!=='Failure')throw new Error('projection_tamper_accepted:'+mode);
           }
           const taskScheduler=createManagedTaskScheduler({persistence:{load:async()=>null,save:async()=>{}},executor:{start:async(_task,control)=>{await control.setChildSessionId('ses_actual_board_child');await control.markAccepted();return {status:'completed',recoverablePreview:'ORIGINAL TERMINAL BOARD RESULT'};},abort:async()=>({aborted:true}),reconcile:async()=>({state:'unavailable'})}});
           const task=yield* Effect.promise(()=>taskScheduler.submit({idempotencyKey:'board-'+contextSession.id,rootSessionId:contextSession.id,directory,mode:'orchestrator',providerId:'sim',modelId:'m1',agent:'explorer',variant:null,label:'Actual terminal board',prompt:'Actual task objective',timeoutAt:null}));
           yield* Effect.promise(()=>taskScheduler.waitForTask(task.taskId));
           const primary=createPrimaryRecoveryController({directory:process.env.TMPDIR+'/primary-'+contextSession.id,isManaged:()=>true,authorize:async()=>true,observeTurn:async()=>null,abortSession:async()=>{},promptSession:async()=>{}});
           yield* Effect.promise(()=>primary.initialize());
           try{
            yield* Effect.promise(()=>primary.admit({sessionID:contextSession.id,directory,primary:true,executionGeneration:2,body:{messageID:'msg_owneduser',agent:'orchestrator',model:{providerID:'sim',modelID:'m1'},variant:'default'}}));
            actualBoardOwner=createNativeSlimContextOwner({originals,primaryRuntime:primary,getManagedRuntime:()=>taskScheduler,locations:[{directory}],openCodeClient:{sessions:{get:async id=>{const session=await Effect.runPromise(api.sessions.get({sessionID:id}));return {id:session.id,directory:session.location.directory,parentID:session.parentID};}}},admissionOwner:{captureSessionHookAuthorization:async input=>async()=>{const current=currentNativeSlimHookAuthority();if(!current||current.permit.token!==input.permit.token||current.sessionID!==input.sessionID||current.directory!==input.directory)throw new Error('actual_board_hook_revoked');}}});
            const boardContext=yield* capturedHooks.trigger('session','context',{...actualResultEvent,messages:[contextEvent.messages[0],{...toolResult,content:[...toolResult.content,...secondResult.content]}]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
            if(boardContext.messages.length!==3||boardContext.messages[2].role!=='user'||boardContext.messages[2].id!=='msg_owneduser-background-job-board'||!boardContext.messages[2].content[0].text.includes('ORIGINAL TERMINAL BOARD RESULT')||Object.hasOwn(boardContext.messages[1],'id'))throw new Error('actual_original_board_insertion_lost');
            if(taskScheduler.getResultEnvelope(task.taskId).promptObserved)throw new Error('board_presentation_collected_early');
            const nextUser={...contextEvent.messages[0],id:'msg_ownednext',content:[{type:'text',text:'Continue actual objective'}]};
            const secondContext=yield* capturedHooks.trigger('session','context',{...actualResultEvent,messages:[contextEvent.messages[0],{...toolResult,content:toolResult.content},nextUser]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
            if(!taskScheduler.getResultEnvelope(task.taskId).promptObserved||taskScheduler.getResultEnvelope(task.taskId).action!==null)throw new Error('actual_board_terminal_cas_lost');
            if(secondContext.messages[2].id!=='msg_ownednext'||secondContext.messages[1].role!=='tool')throw new Error('actual_board_second_context_identity_lost');
            for(const mode of ['base','index','role','nontext','metadata','order']){
             insertionTamper=mode;
             const denied=yield* capturedHooks.trigger('session','context',{...actualResultEvent,messages:[contextEvent.messages[0],{...toolResult,content:toolResult.content}]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
             insertionTamper=undefined;if(denied._tag!=='Failure')throw new Error('forged_board_insertion_accepted:'+mode);
            }
           }finally{actualBoardOwner=undefined;insertionTamper=undefined;yield* Effect.promise(()=>primary.drain());yield* Effect.promise(()=>taskScheduler.shutdown());}
           const duplicateIdentity=yield* capturedHooks.trigger('session','context',{...contextEvent,messages:[contextEvent.messages[0],{...contextEvent.messages[0]}]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
           if(duplicateIdentity._tag!=='Failure')throw new Error('duplicate_native_identity_accepted');
           activeReadSuspended=true;
           const pending=Effect.runFork(capturedHooks.trigger('session','context',{...contextEvent,system:[],messages:[]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id})));
           yield* Effect.promise(()=>activeReadStarted);yield* Fiber.interrupt(pending);activeReadSuspended=false;
           if(!activeReadCancelled)throw new Error('interview_active_read_did_not_cancel');
          }

          yield* capturedHooks.trigger('tool','execute.before',{tool:'read',sessionID:contextSession.id,agent:'builder',messageID:'msg_read',id:'call_read',input:{path:controllerComposition?'/owned-target':'owned-target'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
          if(!escapedRead)throw new Error('hook_read_authority_missing');
          if(controllerComposition&&!contextRpc.length)throw new Error('controller_context_rpc_missing');
          const readExpired=yield* Effect.tryPromise({try:()=>escapedRead('owned-target'),catch:error=>error}).pipe(Effect.exit);
          if(readExpired._tag!=='Failure'||readProofs.at(-1)?.event.id!=='call_read')throw new Error('hook_read_authority_outlived_trigger');
          if(controllerComposition){
           transformRefused=true;
           const transformedRefused=yield* capturedHooks.trigger('session','context',{...contextEvent,system:[],messages:[{...contextEvent.messages[0],content:[{type:'text',text:'Fresh objective'}]}]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
           transformRefused=false;if(transformedRefused._tag!=='Failure')throw new Error('owned_transform_refusal_swallowed');
           pathRefused=true;
           const pathDenied=yield* capturedHooks.trigger('tool','execute.before',{tool:'read',sessionID:contextSession.id,messageID:'msg_read',id:'call_read_denied',input:{path:'/owned-denied'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
           pathRefused=false;if(pathDenied._tag!=='Failure')throw new Error('owned_path_refusal_swallowed');
          }
          interviewRefused=true;
          const interviewDenied=yield* capturedHooks.trigger('session','context',{...contextEvent,system:[],messages:[]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
          interviewRefused=false;if(interviewDenied._tag!=='Failure')throw new Error('owned_interview_refusal_swallowed');
          contextRefused=true;
          const contextDenied=yield* capturedHooks.trigger('session','context',{...contextEvent,system:[],messages:[]}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
          contextRefused=false;if(contextDenied._tag!=='Failure')throw new Error('context_refusal_not_enforced');

          // A real native session event must not trigger package updates or
          // skill installation before the owned snapshot registrations.
          const beforeSessionEvent=networkCalls.length;
          yield* api.sessions.create({location:{directory},agent:'builder'});
          yield* Effect.sleep('20 millis');
          if(networkCalls.length!==beforeSessionEvent)throw new Error('package_session_event_network_attempt');
          const tools=capturedTools; const lists=[];
          if(!capturedCommands)throw new Error('native_command_missing');
          const commands=capturedCommands;yield* commands.list();
          for(const name of ['deepwork','loop','reflect','interview']){
            yield* commands.execute({name,invocation:{sessionID:contextSession.id,prompt:{text:name==='reflect'?'--sessions --last 200 exact focus':'exact task'},delivery:'queue'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
          }
          yield* commands.reload();yield* commands.execute({name:'reflect',invocation:{sessionID:contextSession.id,prompt:{text:'--last 0'},delivery:'steer'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
          commandRefused=true;const denied=yield* commands.execute({name:'deepwork',invocation:{sessionID:contextSession.id,prompt:{text:'denied'},delivery:'queue'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}),Effect.exit);
          if(denied._tag!=='Failure')throw new Error('command_refusal_not_enforced');commandRefused=false;
          for(let index=0;index<2;index++){
            if(index) yield* tools.reload();
            const catalog=yield* tools.list();lists.push(catalog.map(tool=>tool.id));
            const view=yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);
            yield* view.execute({sessionID:contextSession.id,messageID:'msg_fixture',agent:'builder',call:{type:'tool-call',id:'call_'+index,name:'ast_grep_search',input:{pattern:'x',lang:'javascript'}}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:contextSession.id}));
          }
          rows.push({directory,agents:agents.data.map(agent=>({id:agent.id,model:agent.model,system:agent.system})),lists,calls});
        }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
        // Rebinding the same location fails if the real native scope failed
        // to release its frozen configuration registration.
        const releaseProbe=bindReviewedSlimConfiguration({directory,configuration:{}});releaseProbe();
      }
      process.stdout.write(JSON.stringify({rows,networkCalls,commandEvents,disposals,lifecycleEvents,hookAuthorities,controlEvents}));
    `;
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: path.resolve(import.meta.dirname, '../..'),
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, OPENCODE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', DEVRYAN_GRAPH_DIRECTORIES: JSON.stringify(directories) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child?.kill('SIGKILL'), 20_000);
    try {
      const stdout = child.stdout, stderr = child.stderr;
      if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw new Error('Owned pipes required');
      const [text, errors, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), child.exited]);
      expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' });
      const result: {controlEvents:string[];hookAuthorities:{phase:string;token:string;directory:string}[];disposals:string[];lifecycleEvents:unknown[];commandEvents:{event:string;name:string;directory:string;parts?:{text?:string}[];invocation?:{delivery:string}}[];networkCalls:{url:string;stack:string}[];rows:{ directory: string; agents: { id: string; model?: { variant?: string } }[]; lists: string[][]; calls: { toolID: string; directory: string; origin: { id: string } }[] }[]} = JSON.parse(text);
      const submissions=result.commandEvents.filter(event=>event.event==='execute');expect(submissions).toHaveLength(10);expect(result.commandEvents.filter(event=>event.event==='authority')).toHaveLength(20);
      expect(submissions.filter(event=>event.name==='interview').map(event=>event.parts?.[0].text)).toEqual(['<omos-interview-command>exact task</omos-interview-command>','<omos-interview-command>exact task</omos-interview-command>']);
      expect(submissions.filter(event=>event.name==='deepwork').every(event=>event.parts?.[0].text?.includes('exact task'))).toBe(true);
      expect(submissions.filter(event=>event.name==='loop').every(event=>event.parts?.[0].text?.includes('exact task'))).toBe(true);
      expect(submissions.filter(event=>event.name==='reflect').some(event=>event.parts?.[0].text?.includes('100'))).toBe(true);
      expect(submissions.filter(event=>event.name==='reflect').map(event=>event.invocation?.delivery)).toEqual(['queue','steer','queue','steer']);
      const rows=result.rows;// The SDK's local catalog owners probe these exact endpoints once.
      // Fetch remains refused; no package updater or provider traffic is allowed.
      expect(result.networkCalls.map(call=>call.url).sort()).toEqual(['http://127.0.0.1:11434/api/tags','http://127.0.0.1:1234/api/v1/models','http://127.0.0.1:8000/health']);
      expect((await fs.readdir(config)).sort()).toEqual(['oh-my-opencode-slim.json']);
      expect(rows).toHaveLength(3);expect(result.disposals.sort()).toEqual(directories.slice(0,2).sort());expect(result.lifecycleEvents.length).toBeGreaterThan(0);expect(result.controlEvents).toEqual(['control-start','progress','control-finish']);expect(result.hookAuthorities.length).toBeGreaterThan(0);expect(result.hookAuthorities.every(value=>value.token==='f'.repeat(64)&&directories.includes(value.directory))).toBe(true);
      for (const [index, row] of rows.entries()) {
        expect(row.directory).toBe(directories[index]); if(index===2){expect(row.calls).toHaveLength(0);expect(row.lists[0]).toEqual(row.lists[1]);continue;}expect(row.agents.find(agent => agent.id === 'builder')?.model?.variant).toBe(index ? 'medium' : 'high');
        expect(row.lists[0]).toEqual(row.lists[1]);
        for (const list of row.lists) for (const tool of ['webfetch', 'ast_grep_search', 'ast_grep_replace']) expect(list).toContain(tool);
        expect(row.calls).toHaveLength(2); for (const call of row.calls) expect(call).toMatchObject({ toolID: 'ast_grep_search', directory: row.directory, origin: { id: 'devryan.slim' } });
      }
    } finally { clearTimeout(timer); }
  } finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } await fs.rm(root, { recursive: true, force: true }); }
}, 25_000);
