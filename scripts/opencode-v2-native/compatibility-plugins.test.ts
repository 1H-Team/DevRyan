import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {rewriteReviewedSlimServer} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';

test('pinned Slim native setup preserves two location catalogs across tool reload and disposes its native scope', async () => {
  const base = path.resolve(import.meta.dirname, '../../.cache/v2-validation');
  const root = await fs.mkdtemp(path.join(base, 'native-slim-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const home = path.join(root, 'home'), tmp = path.join(home, 'tmp'), config = path.join(home, 'config');
    await fs.mkdir(tmp, { recursive: true }); await fs.mkdir(config);
    await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}');
    await fs.writeFile(path.join(config, 'oh-my-opencode-slim.json'), JSON.stringify({ autoUpdate: false, companion: { enabled: false },
      backgroundJobs: { orchestratorWake: { enabled: false } }, agents: { builder: { model: 'sim/m1', variant: 'high' } } }));
    const directories = [path.join(root, 'one'), path.join(root, 'two')];
    await Promise.all(directories.map(directory => fs.mkdir(directory)));
    const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
    const sdk = new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js', import.meta.url).href;
    const input = new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js', import.meta.url);
    const transformed = rewriteReviewedSlimServer(await fs.readFile(input));
    const reviewedEntry = path.join(root, 'reviewed-slim.mjs');
    await fs.writeFile(reviewedEntry, transformed.contents);
    const slim = pathToFileURL(reviewedEntry).href;
    const source = `
      import { Effect, Layer, Logger } from 'effect';
      import { Global } from '@opencode/util/global';
      import { Tool } from '@opencode/core/tool';
      import { Plugin } from '@opencode/core/plugin';
      import { Command } from '@opencode/core/command';
      const { OpenCode } = await import(${JSON.stringify(sdk)});
      const { default: packagePlugin, bindReviewedSlimConfiguration,bindReviewedSlimHost,createWebfetchTool,ast_grep_search,ast_grep_replace,createDeepworkCommandHook,createLoopCommandHook,createReflectCommandHook } = await import(${JSON.stringify(slim)});
      const { nativeSlimPlugin } = await import(${JSON.stringify(`${host}native-slim.ts`)});
      const { nativeSlimCommandBehaviorsPlugin,reviewedSlimCommandDeclarations } = await import(${JSON.stringify(`${host}native-slim-commands.ts`)});
      const { trustedPluginOverride } = await import(${JSON.stringify(`${host}trusted-plugins.ts`)});
      const { createAdmissionGates } = await import(${JSON.stringify(`${host}admission-gates.ts`)});
      const { OperationPermitRef } = await import(${JSON.stringify(`${host}native-admission-contract.ts`)});
      const { configurationOverridesForSnapshot } = await import(${JSON.stringify(`${host}configuration.ts`)});
      const networkCalls=[];globalThis.fetch = async(input)=>{networkCalls.push({url:String(input instanceof Request?input.url:input),stack:new Error().stack});throw new Error('fixture_network_forbidden')};
      const dirs = JSON.parse(process.env.DEVRYAN_GRAPH_DIRECTORIES);
      const snapshot = {schema:1,revision:1,digest:'b'.repeat(64),registrationManifestDigest:'c'.repeat(64),locations:dirs.map((directory,index)=>({
        directory,configuration:{agents:{builder:{model:{providerID:'sim',model:'m1',variant:index?'medium':'high'},system:'saved-'+index}},default_agent:'builder',snapshots:false,warming:false,plugins:[],commands:{}},skills:[],aliases:[],instructions:[],textReferences:[],compatibility:{commands:{},slim:{mergedConfig:{autoUpdate:false,companion:{enabled:false},backgroundJobs:{orchestratorWake:{enabled:false}},agents:{builder:{model:'sim/m1',variant:index?'medium':'high'}}}}}
      }))};
      const origin = {kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','network','process']};
      const reviewed = nativeSlimPlugin({setup:packagePlugin.setup,bindConfiguration:bindReviewedSlimConfiguration,bindHost:bindReviewedSlimHost,hostBindings:directory=>({directory,requiredHooks:['config','tool'],log:()=>{},
        hooks:async input=>({config:async config=>{config.agent={builder:{model:'sim/m1',variant:dirs.indexOf(directory)?'medium':'high'}}},tool:{webfetch:createWebfetchTool(input),ast_grep_search,ast_grep_replace}}),
        interviewBridge:{registerCommand:()=>{},handleContext:async()=>{},handleEvent:async()=>{},dispose:async()=>{}}}),snapshot,tools:['webfetch','ast_grep_search','ast_grep_replace'],
        delegatedTools:['task_cancel','task_message','task_reply','task_result','task_revive','task_status','wait_for_user'],
        delegatedCommands:['interview','deepwork','loop','reflect','review']});
      const commandEvents=[];let commandRefused=false;
      const commandBehavior=nativeSlimCommandBehaviorsPlugin({snapshot,factories:{deepwork:createDeepworkCommandHook,loop:createLoopCommandHook,reflect:createReflectCommandHook},
        assertCommand:input=>Effect.sync(()=>{commandEvents.push({event:'assert',name:input.name,directory:input.directory});if(commandRefused)throw new Error('command_revoked')}),
        executeCommand:input=>Effect.sync(()=>commandEvents.push({event:'execute',...input}))});
      const commandOrigin={kind:'plugin',id:'devryan.slim-commands',manifestDigest:'d'.repeat(64),capabilities:['control']};
      const reviewedBehaviorCommands=Object.entries(reviewedSlimCommandDeclarations({deepwork:createDeepworkCommandHook,loop:createLoopCommandHook,reflect:createReflectCommandHook})).map(([name,definition])=>({origin:commandOrigin,name,definition}));
      const rows=[];
      for(const directory of dirs){
        let capturedTools,capturedPlugins,capturedCommands; const calls=[];
        const bridge={beginCommand:async input=>{if(!reviewedBehaviorCommands.some(value=>value.name===input.name&&JSON.stringify(value.origin)===JSON.stringify(input.origin)))throw new Error('unreviewed_command');return 'e'.repeat(64);},awaitReady:async()=>{},authorize:async request=>({token:'d'.repeat(64),revision:0,sessionID:request.sessionID}),recheck:async()=>{},release:async()=>{},
          sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
        const gates=createAdmissionGates({bridge,reviewedBehaviorCommands,reviewedConfigurationForDirectory:directory=>snapshot.locations.find(value=>value.directory===directory)?.configuration,nativePlugins:new Map(),executeOwned:call=>{calls.push({toolID:call.toolID,directory:call.location.directory,origin:call.provenance});return Effect.succeed({content:'owned-leaf'});}});
        await gates.controls.openStartup();
        const capture=Plugin.node.replace(Plugin.node.mapLayer(layer=>Layer.effect(Plugin.Service,Effect.gen(function*(){const inner=yield* Plugin.Service;capturedTools=yield* Tool.Service;capturedCommands=yield* Command.Service;capturedPlugins=inner;return inner;})).pipe(Layer.provide(layer))));
        await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
          const api=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},
            {overrides:[...configurationOverridesForSnapshot(snapshot),Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.OPENCODE_CONFIG_DIR,data:process.env.HOME+'/data',state:process.env.HOME+'/state',cache:process.env.HOME+'/cache',tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),
            trustedPluginOverride({plugins:[{plugin:reviewed,origin},{plugin:commandBehavior,origin:commandOrigin}],additionalOrigins:[],nativePlugins:new Map()}),...gates.overrides,capture]});
          yield* api.agent.list({location:{directory}});
          if(!capturedPlugins||!capturedTools) throw new Error('native_catalog_missing');
          yield* capturedPlugins.awaitActivation;
          const agents=yield* api.agent.list({location:{directory}});
          // A real native session event must not trigger package updates or
          // skill installation before the owned snapshot registrations.
          const beforeSessionEvent=networkCalls.length;
          yield* api.sessions.create({location:{directory},agent:'builder'});
          yield* Effect.sleep('20 millis');
          if(networkCalls.length!==beforeSessionEvent)throw new Error('package_session_event_network_attempt');
          const tools=capturedTools; const lists=[];
          if(!capturedCommands)throw new Error('native_command_missing');
          const commands=capturedCommands;yield* commands.list();
          for(const name of ['deepwork','loop','reflect']){
            yield* commands.execute({name,invocation:{sessionID:'ses_fixture',prompt:{text:name==='reflect'?'--sessions --last 200 exact focus':'exact task'},delivery:'queue'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:'ses_fixture'}));
          }
          yield* commands.reload();yield* commands.execute({name:'reflect',invocation:{sessionID:'ses_fixture',prompt:{text:'--last 0'},delivery:'steer'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:'ses_fixture'}));
          commandRefused=true;const denied=yield* commands.execute({name:'deepwork',invocation:{sessionID:'ses_fixture',prompt:{text:'denied'},delivery:'queue'}}).pipe(Effect.provideService(OperationPermitRef,{token:'f'.repeat(64),revision:0,sessionID:'ses_fixture'}),Effect.exit);
          if(denied._tag!=='Failure')throw new Error('command_refusal_not_enforced');commandRefused=false;
          for(let index=0;index<2;index++){
            if(index) yield* tools.reload();
            const catalog=yield* tools.list();lists.push(catalog.map(tool=>tool.id));
            const view=yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);
            yield* view.execute({sessionID:'ses_fixture',messageID:'msg_fixture',agent:'builder',call:{type:'tool-call',id:'call_'+index,name:'ast_grep_search',input:{pattern:'x',lang:'javascript'}}});
          }
          rows.push({directory,agents:agents.data.map(agent=>({id:agent.id,model:agent.model,system:agent.system})),lists,calls});
        }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
        // Rebinding the same location fails if the real native scope failed
        // to release its frozen configuration registration.
        const releaseProbe=bindReviewedSlimConfiguration({directory,configuration:{}});releaseProbe();
      }
      process.stdout.write(JSON.stringify({rows,networkCalls,commandEvents}));
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
      const result: {commandEvents:{event:string;name:string;directory:string;parts?:{text?:string}[];invocation?:{delivery:string}}[];networkCalls:{url:string;stack:string}[];rows:{ directory: string; agents: { id: string; model?: { variant?: string } }[]; lists: string[][]; calls: { toolID: string; directory: string; origin: { id: string } }[] }[]} = JSON.parse(text);
      const submissions=result.commandEvents.filter(event=>event.event==='execute');expect(submissions).toHaveLength(8);
      expect(submissions.filter(event=>event.name==='deepwork').every(event=>event.parts?.[0].text?.includes('exact task'))).toBe(true);
      expect(submissions.filter(event=>event.name==='loop').every(event=>event.parts?.[0].text?.includes('exact task'))).toBe(true);
      expect(submissions.filter(event=>event.name==='reflect').some(event=>event.parts?.[0].text?.includes('100'))).toBe(true);
      expect(submissions.filter(event=>event.name==='reflect').map(event=>event.invocation?.delivery)).toEqual(['queue','steer','queue','steer']);
      const rows=result.rows;// The SDK's local catalog owners probe these exact endpoints once.
      // Fetch remains refused; no package updater or provider traffic is allowed.
      expect(result.networkCalls.map(call=>call.url).sort()).toEqual(['http://127.0.0.1:11434/api/tags','http://127.0.0.1:1234/api/v1/models','http://127.0.0.1:8000/health']);
      expect((await fs.readdir(config)).sort()).toEqual(['oh-my-opencode-slim.json']);
      expect(rows).toHaveLength(2);
      for (const [index, row] of rows.entries()) {
        expect(row.directory).toBe(directories[index]); expect(row.agents.find(agent => agent.id === 'builder')?.model?.variant).toBe(index ? 'medium' : 'high');
        expect(row.lists[0]).toEqual(row.lists[1]);
        for (const list of row.lists) for (const tool of ['webfetch', 'ast_grep_search', 'ast_grep_replace']) expect(list).toContain(tool);
        expect(row.calls).toHaveLength(2); for (const call of row.calls) expect(call).toMatchObject({ toolID: 'ast_grep_search', directory: row.directory, origin: { id: 'devryan.slim' } });
      }
    } finally { clearTimeout(timer); }
  } finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } await fs.rm(root, { recursive: true, force: true }); }
}, 25_000);
