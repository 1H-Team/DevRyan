import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeSettingsDirectory} from '../native-settings-directory.mjs';
import {createDesktopSettings} from '../desktop-settings.mjs';
test('desktop settings follow valid native selection; host root and invalid selection remain explicit',()=>{
 let selected=false;const environment={OPENCHAMBER_DATA_DIR:'/fixture/old',XDG_STATE_HOME:'/fixture/state'};
 const resolve=createNativeSettingsDirectory({environment,home:'/fixture/home',existsSync:()=>selected,readRuntimeBundleBinding:input=>{assert.equal(input.DEVRYAN_RUNTIME_BUNDLE_ROOT,'/fixture/state/devryan/runtime-bundles');return {descriptor:{launch:{webDataDirectory:'/fixture/native/web-data'}}};}});
 assert.equal(resolve(),'/fixture/old');selected=true;assert.equal(resolve(),'/fixture/native/web-data');assert.equal(environment.OPENCHAMBER_DATA_DIR,'/fixture/old');
 const invalid=createNativeSettingsDirectory({environment,home:'/fixture/home',existsSync:()=>true,readRuntimeBundleBinding:()=>{throw new Error('bundle_binding_invalid');}});assert.throws(invalid,/bundle_binding_invalid/);
});
test('held native selection permits only settings path inspection for the recovery shell',()=>{
 const resolve=createNativeSettingsDirectory({environment:{DEVRYAN_RUNTIME_BUNDLE_ROOT:'/fixture/bundles'},home:'/fixture/home',existsSync:()=>true,
  readRuntimeBundleBinding:(input,options)=>{assert.deepEqual(input,{DEVRYAN_RUNTIME_BUNDLE_ROOT:'/fixture/bundles'});assert.deepEqual(options,{allowHeldInspection:true});
   return {admission:'held',descriptor:{launch:{webDataDirectory:'/fixture/held/web-data'}}};}});
 assert.equal(resolve(),'/fixture/held/web-data');
});
test('settings mutation writes to the same captured root across a concurrent startup binding',async()=>{
 let directory='/fixture/old';const writes=[];
 const owner=createDesktopSettings({fs:{readFileSync:()=>'{"themeId":"dark"}'},fsp:{mkdir:async()=>{},writeFile:async(file)=>{writes.push(file);},rename:async(_from,to)=>writes.push(to),rm:async()=>{}},os:{homedir:()=>'/fixture/home'},process:{env:{},pid:1},log:{},getMainWindow:()=>null,minWidth:1,minHeight:1,LOCAL_HOST_ID:'local',resolveDataDirectory:()=>directory});
 await owner.mutateSettingsRoot(async root=>{directory='/fixture/native';return {...root,themeId:'light'};});
 assert.equal(writes.at(-1),'/fixture/old/settings.json');assert.equal(owner.settingsFilePath(),'/fixture/native/settings.json');
});
test('desktop checkpoint waits admitted writes and cancels delayed geometry persistence',async()=>{
 const started=Promise.withResolvers(),release=Promise.withResolvers(),timers=[],writes=[];
 const owner=createDesktopSettings({fs:{readFileSync:()=>'{"themeId":"dark"}'},fsp:{mkdir:async()=>{},writeFile:async()=>{started.resolve();await release.promise;},rename:async(_from,to)=>writes.push(to),rm:async()=>{}},
  os:{homedir:()=>'/fixture/home'},process:{env:{},pid:1},log:{warn:()=>assert.fail('Held timer must not attempt a write')},getMainWindow:()=>null,minWidth:1,minHeight:1,LOCAL_HOST_ID:'local',setTimeout:fn=>timers.push(fn)});
 const mutation=owner.mutateSettingsRoot(root=>({...root,themeId:'light'}));await started.promise;
 owner.debounceWindowStatePersist({id:7,isDestroyed:()=>false});
 const drain=owner.holdForCheckpoint();assert.equal(owner.holdForCheckpoint(),drain);
 let drained=false;void drain.then(()=>{drained=true;});
 await assert.rejects(owner.mutateSettingsRoot(()=>({})),{code:'bundle_desktop_settings_held'});
 for(const timer of timers)timer();assert.equal(drained,false);assert.equal(writes.length,0);
 release.resolve();await mutation;await drain;assert.equal(writes.length,1);assert.equal(drained,true);
 owner.debounceWindowStatePersist({id:7,isDestroyed:()=>false},true);assert.equal(writes.length,1);
});
test('a failed desktop settings write leaves checkpoint admission held',async()=>{
 const owner=createDesktopSettings({fs:{readFileSync:()=>'{}'},fsp:{mkdir:async()=>{},writeFile:async()=>{},rename:async()=>{throw Error('fixture write failure');},rm:async()=>{}},
  os:{homedir:()=>'/fixture/home'},process:{env:{},pid:1},log:{},getMainWindow:()=>null,minWidth:1,minHeight:1,LOCAL_HOST_ID:'local'});
 await assert.rejects(owner.mutateSettingsRoot(()=>({})),/fixture write failure/);
 await assert.rejects(owner.holdForCheckpoint(),{code:'bundle_desktop_settings_unsettled'});
 await assert.rejects(owner.mutateSettingsRoot(()=>({})),{code:'bundle_desktop_settings_held'});
});
