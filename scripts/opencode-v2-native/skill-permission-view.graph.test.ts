import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('actual native permission reads translate persisted skill aliases only inside the current location evaluation', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const base = path.join(repository, '.cache/v2-validation'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'skill-permission-view-'));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
  const directories = [path.join(root, 'one'), path.join(root, 'two')];
  await Promise.all([tmp, ...directories].map(directory => fs.mkdir(directory, { recursive: true })));
  await Promise.all(directories.map(directory => fs.mkdir(path.join(directory, '.git'))));
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
  const sdk = new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js', import.meta.url).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const source = `
      import assert from 'node:assert/strict';
      import {Effect,Layer,Logger,Cause,Context} from 'effect';
      import {Global} from '@opencode/util/global';
      import {Permission} from '@opencode/core/permission';
      import {PermissionSaved} from '@opencode/core/permission/saved';
      import {Session} from '@opencode/core/session';
      import {SessionStore} from '@opencode/core/session/store';
      import {Location} from '@opencode/core/location';
      import {Bus} from '@opencode/core/bus';
      import {SessionExecution} from '@opencode/core/session/execution';
      import {makeGlobalNode} from '@opencode/util/effect/app-node';
      import {LocationActivity} from '@opencode/core/location-activity';
      import {LocationServiceMap} from '@opencode/core/location-service-map';
      import {Plugin} from '@opencode/core/plugin';
      import {PluginHooks} from '@opencode/core/plugin/hooks';
      const {OpenCode}=await import(${JSON.stringify(sdk)});
      const {createAdmissionGates}=await import(${JSON.stringify(host+'admission-gates.ts')});
      const {configurationOverrides}=await import(${JSON.stringify(host+'configuration.ts')});
      const {createReviewedNativePluginRegistry}=await import(${JSON.stringify(host+'native-plugin-registry.ts')});
      const directories=JSON.parse(process.env.DEVRYAN_GRAPH_DIRECTORIES);
      const skills=directories.map((directory,index)=>[{id:'devryan.skill.'+index,name:'legacy-review',path:directory+'/skills/legacy-review/SKILL.md',content:'owned',description:'owned',source:'fixture',scope:'project',bodySha256:'a'.repeat(64),fileSha256:'b'.repeat(64),resources:[]}]);
      const bridge={awaitReady:async()=>{},authorize:async r=>({token:'d'.repeat(64),revision:0,sessionID:r.sessionID}),recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
      const translations=[];const gates=createAdmissionGates({bridge,nativePlugins:createReviewedNativePluginRegistry('c'.repeat(64)),executeOwned:()=>Effect.die('no tool execution'),reviewedSkillsForDirectory:d=>{translations.push(d);return skills[directories.indexOf(d)]??[];}});
      await gates.controls.openStartup();
      let map,store,saved,sessionService,retainedRead,foreignRead=false;
      const views=[];
      const overrides=[...configurationOverrides({}),Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,cache:process.env.XDG_CACHE_HOME,tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),...gates.overrides,
        PluginHooks.node.replace(PluginHooks.node.mapLayer(layer=>Layer.effect(PluginHooks.Service,Effect.gen(function*(){const inner=yield* PluginHooks.Service;return {...inner,trigger:(domain,name,event)=>Effect.gen(function*(){
          if(domain==='permission'&&name==='evaluate'){
            const context=yield* Effect.context();
            const location=yield* Location.Service;
            const session=yield* store.get(event.sessionID);
            const rows=yield* saved.list({projectID:location.project.id});
            views.push({permissions:session.permissions,rows});
            retainedRead=store.get(event.sessionID).pipe(Effect.provideContext(context));
            if(foreignRead)yield* saved.list();
          }
          return yield* inner.trigger(domain,name,event);
        })};})).pipe(Layer.provide(layer)))),
        LocationActivity.node.replace(makeGlobalNode({service:LocationActivity.Service,deps:[Bus.node,SessionExecution.node,LocationServiceMap.node,SessionStore.node,PermissionSaved.node,Session.node],layer:Layer.effect(LocationActivity.Service,Effect.gen(function*(){sessionService=yield* Session.Service;store=yield* SessionStore.Service;saved=yield* PermissionSaved.Service;map=yield* LocationServiceMap.Service;return yield* LocationActivity.Service;})).pipe(Layer.provide(LocationActivity.layer()))}))];
      const old=[];
      await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
        const api=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides});
        const ForgedView=Context.Reference('DevRyan/SkillPermissionView',{defaultValue:()=>undefined});
        const forged=yield* Effect.exit(saved.list().pipe(Effect.provideService(ForgedView,{active:true,current:()=>true})));
        assert.equal(forged._tag,'Failure');assert.match(String(Cause.squash(forged.cause)),/native_permission_location_expired/);
        assert.deepEqual(yield* saved.list(),[]);
        const at=(directory,action)=>action.pipe(Effect.provide(LocationServiceMap.Service.get({directory})),Effect.provideService(LocationServiceMap.Service,map));
        for(let i=0;i<directories.length;i++){
          const directory=directories[i],id=skills[i][0].id;
          const rules=[{action:'skill',resource:'*',effect:'allow'},{action:'skill',resource:'legacy-review',effect:'deny'}];
          const denied=yield* api.sessions.create({location:{directory},permissions:rules});
          yield* api.agent.list({location:{directory}});
          const capture=yield* at(directory,Effect.gen(function*(){yield* (yield* Plugin.Service).awaitActivation;const permission=yield* Permission.Service;const location=yield* Location.Service;return {permission:{...permission,assert:input=>permission.assert(input).pipe(Effect.provideService(Location.Service,location)),ask:input=>permission.ask(input).pipe(Effect.provideService(Location.Service,location)),reply:input=>permission.reply(input).pipe(Effect.provideService(Location.Service,location))},location};}));
          const request={sessionID:denied.id,action:'skill',resources:[id],agent:'build'};
          const deniedExit=yield* Effect.exit(capture.permission.assert(request));
          assert.equal(deniedExit._tag,'Failure',JSON.stringify({translations,views,stored:yield* store.get(denied.id)}));assert.equal(Cause.squash(deniedExit.cause)._tag,'Permission.BlockedError',String(Cause.squash(deniedExit.cause)));
          assert.deepEqual((yield* store.get(denied.id)).permissions,rules);
          // A foreign native location cannot evaluate this session's aliases.
          if(i===1){const foreign=yield* Effect.exit(capture.permission.ask({...request,sessionID:old[0].sessionID}));assert.equal(foreign._tag,'Failure');assert.match(String(Cause.squash(foreign.cause)),/native_permission_session_mismatch/);}
          const allowRules=[{action:'skill',resource:'*',effect:'deny'},{action:'skill',resource:'legacy-review',effect:'allow'}];
          const allowed=yield* api.sessions.create({location:{directory},permissions:allowRules});
          yield* capture.permission.assert({...request,sessionID:allowed.id});
          assert.deepEqual((yield* store.get(allowed.id)).permissions,allowRules);
          const remembered=yield* api.sessions.create({location:{directory},permissions:[{action:'skill',resource:'*',effect:'ask'}]});
          yield* saved.add({projectID:capture.location.project.id,action:'skill',resources:['legacy-review']});
          yield* saved.add({projectID:capture.location.project.id,action:'read',resources:['unchanged']});
          const before=yield* saved.list({projectID:capture.location.project.id});
          yield* capture.permission.assert({...request,sessionID:remembered.id});
          const view=views.at(-1);assert.equal(view.rows.length,before.length);
          assert.deepEqual(view.rows.map(row=>row.id),before.map(row=>row.id));
          assert.deepEqual(view.rows.map(row=>row.resource),before.map(row=>row.action==='skill'?id:row.resource));
          assert.deepEqual(yield* saved.list({projectID:capture.location.project.id}),before);
          // Configured deny remains stronger than remembered allows.
          const stillDenied=yield* Effect.exit(capture.permission.assert(request));assert.equal(stillDenied._tag,'Failure');assert.equal(Cause.squash(stillDenied.cause)._tag,'Permission.BlockedError');
          const expired=yield* Effect.exit(retainedRead);assert.equal(expired._tag,'Failure');assert.match(String(Cause.squash(expired.cause)),/native_permission_location_expired/);
          foreignRead=true;const noProject=yield* Effect.exit(capture.permission.ask({...request,sessionID:remembered.id}));foreignRead=false;
          assert.equal(noProject._tag,'Failure');assert.match(String(Cause.squash(noProject.cause)),/native_permission_project_mismatch/);
          // An 'always' reply reevaluates another real pending session. A
          // newly configured alias deny must prevent its automatic release.
          const askRules=[{action:'skill',resource:'*',effect:'ask'}];
          const pendingOne=yield* api.sessions.create({location:{directory},permissions:askRules});
          const pendingTwo=yield* api.sessions.create({location:{directory},permissions:askRules});
          const otherResource='devryan.skill.pending';
          const a=yield* capture.permission.ask({...request,sessionID:pendingOne.id,resources:[otherResource],save:[otherResource]});
          const b=yield* capture.permission.ask({...request,sessionID:pendingTwo.id,resources:[id]});
          assert.equal(a.effect,'ask');assert.equal(b.effect,'allow');
          // Remove the real remembered alias rule so two requests are pending.
          for(const row of before.filter(row=>row.action==='skill'))yield* saved.remove(row.id);
          const c=yield* capture.permission.ask({...request,sessionID:pendingTwo.id,resources:[id]});assert.equal(c.effect,'ask');
          yield* sessionService.setPermissions({sessionID:pendingTwo.id,permissions:rules});
          yield* capture.permission.reply({requestID:a.id,reply:'always'});
          assert.ok(yield* capture.permission.get(c.id));
          assert.equal(yield* capture.permission.get(a.id),undefined);
          assert.deepEqual((yield* store.get(pendingTwo.id)).permissions,rules);
          yield* capture.permission.reply({requestID:c.id,reply:'reject'});
          // The new remembered rule is an actual native reply side effect, not
          // a permission-view rewrite. Capture the persisted list for reload.
          yield* saved.add({projectID:capture.location.project.id,action:'skill',resources:['legacy-review']});
          yield* capture.permission.assert({...request,sessionID:remembered.id});
          const finalSaved=yield* saved.list({projectID:capture.location.project.id});
          old.push({...capture,sessionID:denied.id,allowedID:allowed.id,rememberedID:remembered.id,before:finalSaved,rules,allowRules});
        }
        yield* LocationServiceMap.reload().pipe(Effect.provideService(LocationServiceMap.Service,map));
        for(let i=0;i<old.length;i++){
          const previous=old[i],directory=directories[i],id=skills[i][0].id;
          const stale=yield* Effect.exit(previous.permission.ask({sessionID:previous.sessionID,action:'skill',resources:[id]}));
          assert.equal(stale._tag,'Failure');assert.match(String(Cause.squash(stale.cause)),/native_permission_location_expired/);
          yield* api.agent.list({location:{directory}});
          const permission=yield* at(directory,Effect.gen(function*(){yield* (yield* Plugin.Service).awaitActivation;const permission=yield* Permission.Service;const location=yield* Location.Service;return {...permission,assert:input=>permission.assert(input).pipe(Effect.provideService(Location.Service,location))};}));
          const deny=yield* Effect.exit(permission.assert({sessionID:previous.sessionID,action:'skill',resources:[id],agent:'build'}));assert.equal(deny._tag,'Failure');assert.equal(Cause.squash(deny.cause)._tag,'Permission.BlockedError');
          yield* permission.assert({sessionID:previous.allowedID,action:'skill',resources:[id],agent:'build'});
          yield* permission.assert({sessionID:previous.rememberedID,action:'skill',resources:[id],agent:'build'});
          assert.deepEqual((yield* store.get(previous.sessionID)).permissions,previous.rules);
          assert.deepEqual((yield* store.get(previous.allowedID)).permissions,previous.allowRules);
          assert.deepEqual(yield* saved.list({projectID:previous.location.project.id}),previous.before);
        }
      }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
      for(const previous of old){const ended=await Effect.runPromise(Effect.exit(previous.permission.ask({sessionID:previous.sessionID,action:'skill',resources:['devryan.skill.0']})));assert.equal(ended._tag,'Failure');assert.match(String(Cause.squash(ended.cause)),/native_permission_location_expired/);}
      process.stdout.write(JSON.stringify({locations:old.length,persistedRulesUnchanged:true,rememberedOrdering:true,reloadFenced:true,expiredEvaluationFenced:true}));
    `;
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: repository,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', DEVRYAN_GRAPH_DIRECTORIES: JSON.stringify(directories) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child?.kill('SIGKILL'), 40_000);
    try {
      const stdout = child.stdout, stderr = child.stderr;
      if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw new Error('Owned pipes required');
      const [output, errors, code] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), child.exited]);
      if (code !== 0) throw new Error(errors.slice(0, 8192));
      expect(code).toBe(0); expect(errors).toBe('');
      expect(JSON.parse(output)).toEqual({ locations: 2, persistedRulesUnchanged: true, rememberedOrdering: true, reloadFenced: true, expiredEvaluationFenced: true });
    } finally { clearTimeout(timer); }
  } finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } await fs.rm(root, { recursive: true, force: true }); }
}, 45_000);
