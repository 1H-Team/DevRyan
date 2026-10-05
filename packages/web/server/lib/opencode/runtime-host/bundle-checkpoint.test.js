import {test,expect,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRuntimeBundleCheckpoint} from './bundle-checkpoint.js';

const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

test('original checkpoint captures before controller stop and expires the closed copy scope',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/bundle-checkpoint-'));roots.push(root);
 const launch=Object.fromEntries(['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory'].map(key=>[key,path.join(root,key)]));
 for(const value of Object.values(launch))await fs.mkdir(value);
 const order=[];let exited=false,held=false,current;
 const controller={hasExited:()=>exited,call:async value=>{expect(value).toEqual({action:'quiesce'});order.push('quiesce');},close:async()=>{order.push('exit');exited=true;}};
 current=controller;
 const checkpoint=createRuntimeBundleCheckpoint({ownerID:'A',generation:2,launch,
  closeAdmission:async()=>{held=true;order.push('admission');},getController:()=>current,
  stopProducers:async()=>order.push('producers'),beforeControllerStop:async()=>{expect(exited).toBe(false);order.push('capture');},
  executionHost:{drain:async()=>order.push('execution')},afterExit:async()=>order.push('after-exit'),drainStores:async()=>order.push('stores'),
  assertAdmissionClosed:async()=>{if(!held)throw Error('admission opened');}});
 let retained;
 await checkpoint({kind:'bundle',bundleID:'A'},async(proof,scope)=>{
  expect(proof.ownerID).toBe('A');expect(exited).toBe(true);retained=scope;
  await scope.assertHeld();current=null;await scope.assertHeld();
  current={hasExited:()=>true};await expect(scope.assertHeld()).rejects.toMatchObject({code:'bundle_checkpoint_scope_expired'});
  current=null;held=false;await expect(scope.assertHeld()).rejects.toThrow('admission opened');held=true;
 });
 expect(order).toEqual(['admission','quiesce','producers','capture','exit','execution','after-exit','stores']);
 await expect(retained.assertHeld()).rejects.toMatchObject({code:'bundle_checkpoint_scope_expired'});
 await checkpoint({kind:'bundle',bundleID:'A'},async(_proof,scope)=>{
  await scope.assertHeld();
  await expect(retained.assertHeld()).rejects.toMatchObject({code:'bundle_checkpoint_scope_expired'});
 });
 await expect(checkpoint({kind:'bundle',bundleID:'B'},async()=>{})).rejects.toMatchObject({code:'bundle_checkpoint_source_mismatch'});
});

test('unknown previously started source cannot receive a never-started checkpoint implicitly',async()=>{
 const checkpoint=createRuntimeBundleCheckpoint({ownerID:'A',generation:2,launch:{},closeAdmission:async()=>{},getController:()=>null,
  stopProducers:async()=>{},drainStores:async()=>{},executionHost:{drain:async()=>{}}});
 await expect(checkpoint({kind:'bundle',bundleID:'A'},async()=>{})).rejects.toMatchObject({code:'bundle_checkpoint_controller_unknown'});
});

test('settlement scope uses returned successful original close receipt and both drained registries after original queues',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/bundle-checkpoint-'));roots.push(root);
 const launch=Object.fromEntries(['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory'].map(key=>[key,path.join(root,key)]));
 for(const directory of Object.values(launch))await fs.mkdir(directory);launch.global={state:path.join(root,'state')};await fs.mkdir(launch.global.state);
 let exited=false,drained=false;const order=[];
 const receipt={path:path.join(root,'termination.json'),terminated:true,confined:true,cancelled:false,exitCode:0};
 const controller={pid:12345,hasExited:()=>exited,call:async()=>{},close:async()=>{exited=true;order.push('exit');return {pid:12345,instanceID:'00000000-0000-4000-8000-000000000001',expected:true,code:0,signal:null,receipt};}};
 const checkpoint=createRuntimeBundleCheckpoint({ownerID:'B',generation:2,launch,getController:()=>controller,readProcessIdentity:pid=>({pid,startIdentity:'original start'}),closeAdmission:async()=>{},stopProducers:async()=>{},beforeControllerStop:async()=>order.push('credential-drain'),executionHost:{drain:async()=>order.push('workers')},drainStores:async()=>{drained=true;order.push('stores');await fs.writeFile(path.join(launch.global.state,'managed-native-provider-processes.json'),JSON.stringify({version:2,processes:[]}));}});
 await checkpoint({kind:'bundle',bundleID:'B'},async(_proof,scope)=>{expect(drained).toBe(true);expect(scope.settlement).toMatchObject({credentialDrained:true,storesDrained:true,controller:{pid:12345,receipt}});expect(scope.settlement.registries.map(row=>[row.name,row.sha256===null])).toEqual([['managed-opencode-processes.json',true],['managed-native-provider-processes.json',false]]);});
 expect(order).toEqual(['credential-drain','exit','workers','stores']);
});
