import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';
import {Effect,Exit,Schema,Layer} from 'effect';
import {LayerNode} from '@opencode/util/effect/layer-node';import {Global} from '@opencode/util/global';
import {Project} from '@opencode/core/project';import {AbsolutePath} from '@opencode/schema/schema';
import {Bus} from '@opencode/core/bus';import {Database} from '@opencode/core/database/database';
import {SessionStore} from '@opencode/core/session/store';import {SessionProjector} from '@opencode/core/session/projector';
import {SessionEvent} from '@opencode/core/session/event';import {SessionSchema} from '@opencode/core/session/schema';
import {NativeHelperTitleRef,assertNativeHelperTitle} from '../../packages/web/server/lib/opencode/runtime-host/native-helper-title.js';
import {primaryStepOverride} from '../../packages/web/server/lib/opencode/runtime-host/primary-step.js';

test('generated title uses the sole native Bus transaction and loses safely to a manual rename',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/helper-title-'));
 const sessionID=SessionSchema.ID.make('ses_helper_title');
 let database:Database.Interface|undefined;
 const capture=Database.node.replace(Database.node.mapLayer(layer=>Layer.effect(Database.Service,Effect.gen(function*(){database=yield* Database.Service;return database;})).pipe(Layer.provide(layer))));
 const override=primaryStepOverride(async()=>{throw Error('No Step');},undefined,undefined,undefined,undefined,undefined,event=>assertNativeHelperTitle(database,event));
 const layer=LayerNode.compile(LayerNode.group([SessionStore.node,SessionProjector.node,Bus.node,Database.node,Project.node]),{replacements:[override,capture,Global.node.replace(Global.layerWith({home:root,config:root,data:root,state:root,tmp:root,cache:root,bin:root,log:root,repos:root}))]});
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const bus=yield* Bus.Service,store=yield* SessionStore.Service;
  const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(root));
  yield* bus.publish(SessionEvent.Created,Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,projectID:project.id,location:{directory:root},slug:'helper-title',agent:'build',model:{providerID:'fixture',id:'m1'},version:'2.0.20'}));
  const input={directory:root,sessionID,title:'Generated title',expectedTitle:''};
  yield* bus.publish(SessionEvent.Renamed,{sessionID,title:input.title}).pipe(Effect.provideService(NativeHelperTitleRef,input));
  expect((yield* store.get(sessionID))?.title).toBe(input.title);
  yield* bus.publish(SessionEvent.Renamed,{sessionID,title:'Manual title'});
  const failed=yield* Effect.exit(bus.publish(SessionEvent.Renamed,{sessionID,title:'Stale generated'}).pipe(Effect.provideService(NativeHelperTitleRef,{...input,title:'Stale generated',expectedTitle:input.title})));
  expect(Exit.isFailure(failed)).toBe(true);expect((yield* store.get(sessionID))?.title).toBe('Manual title');
  yield* bus.publish(SessionEvent.Renamed,{sessionID,title:'Manual after helper'});expect((yield* store.get(sessionID))?.title).toBe('Manual after helper');
 })).pipe(Effect.provide(layer),Effect.timeout('10 seconds')));}finally{await fs.rm(root,{recursive:true,force:true});}
});
