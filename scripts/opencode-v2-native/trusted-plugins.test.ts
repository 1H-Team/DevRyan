import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Location } from '@opencode/core/location';
import type { RegistrationOrigin } from '../../packages/web/server/lib/opencode/runtime-host/registration-origin.js';

test('real SDK plugin activation seals each host location before native snapshot execution', async () => {
  const base = path.resolve(import.meta.dirname, '../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'trusted-plugin-graph-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const scratch = path.join(root, 'scratch'), tmp = path.join(scratch, 'tmp');
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
    const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
    // Fresh globals precede native imports. This uses actual SdkPlugins,
    // PluginHost activation, Tool state and native snapshot execution.
    const source = `
      import { Cause, Context, Effect, Layer, Logger, Option, Schema } from 'effect';
      import { Global } from '@opencode/util/global';
      import { Tool } from '@opencode/core/tool';
      import { Plugin } from '@opencode/core/plugin';
      import { Permission } from '@opencode/core/permission';
      const { OpenCode } = await import(${JSON.stringify(new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js', import.meta.url).href)});
      const { trustedPluginOverride } = await import(${JSON.stringify(`${host}trusted-plugins.ts`)});
      const { createAdmissionGates } = await import(${JSON.stringify(`${host}admission-gates.ts`)});
      const { configurationOverrides } = await import(${JSON.stringify(`${host}configuration.ts`)});
      const { managedTaskPlugin } = await import(${JSON.stringify(`${host}managed-task.ts`)});
      const { runWithHostRefusal } = await import(${JSON.stringify(`${host}host-refusal.ts`)});
      const origin = { kind:'plugin',id:'devryan.managed-task',manifestDigest:'a'.repeat(64),capabilities:['managed-task'] };
      const output = [];
      for (const directory of JSON.parse(process.env.DEVRYAN_GRAPH_DIRECTORIES)) {
        const observed = [];
        let permission, capturedTools, capturedPlugins, nativeLocation, savedSnapshot, savedInvocation;
        const reviewedPlugin = { ...managedTaskPlugin, effect:context=>{
          nativeLocation = structuredClone(context.location);
          return Effect.gen(function*(){
            if(Option.isSome(Context.getOption(yield* Effect.context(),Permission.Service))) throw new Error('SDK plugin borrowed full Permission.Service');
            return yield* managedTaskPlugin.effect(context);
          });
        } };
        const bridge = { awaitReady:async()=>{}, authorize:async request=>({token:'b'.repeat(64),revision:0,sessionID:request.sessionID}),
          recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},
          registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false };
        const gates = createAdmissionGates({ bridge,nativePlugins:new Map(),executeOwned: call=>{
          observed.push({ provenance:call.provenance,location:call.location,
            frozen:Object.isFrozen(call.location)&&Object.isFrozen(call.location.project) });
          permission = call.nativePermissionAssert;
          return Effect.succeed({content:'owned'});
        } });
        await gates.controls.openStartup();
        const scratch = process.env.HOME;
        const capture = Plugin.node.replace(Plugin.node.mapLayer(layer=>Layer.effect(Plugin.Service,Effect.gen(function*(){
          const inner = yield* Plugin.Service;
          capturedTools = yield* Tool.Service;
          capturedPlugins = inner;
          return inner;
        })).pipe(Layer.provide(layer))));
        const replacements = [
          ...configurationOverrides({}), Global.node.replace(Global.layerWith({home:scratch,data:scratch+'/data',cache:scratch+'/cache',config:scratch+'/config',
            state:scratch+'/state',tmp:scratch+'/tmp',bin:scratch+'/bin',log:scratch+'/log',repos:scratch+'/repos'})),
          trustedPluginOverride({plugins:[{plugin:reviewedPlugin,origin}],additionalOrigins:[],nativePlugins:new Map()}),...gates.overrides,capture ];
        await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
          const sdk = yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},
            fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides:replacements});
          const unreviewed = yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(sdk.plugin(managedTaskPlugin))));
          if(unreviewed.ok) throw new Error('Unreviewed registration succeeded');
          const catalog = yield* sdk.agent.list({location:{directory}});
          if(catalog.location.directory!==directory) throw new Error('Native catalog location mismatch');
          if(!capturedTools || !capturedPlugins) throw new Error('SDK registration graph unavailable');
          yield* capturedPlugins.awaitActivation;
          const tools = capturedTools;
          const snapshot = yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);
          const permissionSession = yield* sdk.sessions.create({location:{directory},permissions:[
            {action:'read',resource:'*',effect:'allow'},{action:'write',resource:'*',effect:'deny'}]});
          const invocation = {sessionID:permissionSession.id,messageID:'msg_fixture',agent:'orchestrator',
            call:{type:'tool-call',id:'call_fixture',name:'devryan_task',input:{action:'status',task_id:'task_fixture'}}};
          savedSnapshot = snapshot; savedInvocation = invocation;
          const result = yield* snapshot.execute(invocation);
          yield* permission({sessionID:permissionSession.id,action:'read',resources:[directory]});
          const deniedPermission = yield* Effect.exit(permission({sessionID:permissionSession.id,action:'write',resources:[directory]}));
          if(deniedPermission._tag!=='Failure') throw new Error('Native permission denial bypassed');
          const permissionError = Cause.squash(deniedPermission.cause)._tag;
          yield* tools.transform(editor=>editor.add({name:'unreviewed',description:'unreviewed',input:Schema.Struct({}),
            execute:()=>Effect.die(new Error('unreviewed executor ran'))}));
          const next = yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);
          const absent = yield* Effect.exit(next.execute({...invocation,call:{...invocation.call,name:'unreviewed',input:{}}}));
          output.push({directory,nativeLocation,observed,result,unreviewed:unreviewed.refusal.code,permissionError,
            absent:{kind:absent._tag,message:absent._tag==='Failure'?Cause.squash(absent.cause).message:undefined}});
        }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
        const expired = await runWithHostRefusal(()=>Effect.runPromise(savedSnapshot.execute(savedInvocation)));
        if(expired.ok) throw new Error('Closed location snapshot executed');
        output.at(-1).expired = expired.refusal.code;
      }
      process.stdout.write(JSON.stringify(output));
    `;
    const directories = [path.join(root, 'first'), path.join(root, 'second')];
    await Promise.all(directories.map(directory => fs.mkdir(directory)));
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: path.resolve(import.meta.dirname, '../..'),
      env: { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(scratch, 'config'),
        XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_STATE_HOME: path.join(scratch, 'state'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', DEVRYAN_GRAPH_DIRECTORIES: JSON.stringify(directories) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child?.kill('SIGKILL'), 20_000);
    try {
      const stdout = child.stdout, stderr = child.stderr;
      if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw new Error('Owned pipes required');
      const [text, errors, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), child.exited]);
      expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' });
      const rows: { directory: string; nativeLocation: Location.Info;
        observed: { provenance: RegistrationOrigin; location: Location.Info; frozen: boolean }[];
        result: { content: { type: 'text'; text: string }[] }; unreviewed: string; permissionError: string; expired: string;
        absent: { kind: string; message: string } }[] = JSON.parse(text);
      expect(rows).toHaveLength(directories.length);
      for (const [index, row] of rows.entries()) {
        expect(directories[index]).toBe(row.nativeLocation.directory);
        expect(row).toEqual({ directory: directories[index], nativeLocation: row.nativeLocation,
          observed: [{ provenance: { kind: 'plugin', id: 'devryan.managed-task', manifestDigest: 'a'.repeat(64), capabilities: ['managed-task'] },
            location: row.nativeLocation, frozen: true }], result: { content: [{ type: 'text', text: 'owned' }] },
          unreviewed: 'unreviewed_plugin', permissionError: 'Permission.BlockedError', expired: 'native_tool_location_expired',
          absent: { kind: 'Failure', message: 'DevRyan tool unavailable: unreviewed' } });
      }
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 25_000);
