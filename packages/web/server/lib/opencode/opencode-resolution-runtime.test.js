import {expect,it} from 'vitest';
import {createOpenCodeResolutionRuntime} from './opencode-resolution-runtime.js';
it('reports only the selected verified controller without an ambient lookup or installer',()=>{
 const runtime=createOpenCodeResolutionRuntime({getNativeBundle:()=>({descriptor:{generation:2},artifacts:{controller:'/fixture/controller'}}),getDetectedOpenCodeVersion:()=> '2.0.20'});
 expect(runtime.getOpenCodeResolutionSnapshot()).toEqual({targetVersion:'2.0.20',detectedVersion:'2.0.20',resolved:'/fixture/controller',source:'verified-native-bundle',launchBinary:'/fixture/controller',launchArgs:[],viaWsl:false});
 for(const bundle of [null,{descriptor:{generation:1}}])expect(()=>createOpenCodeResolutionRuntime({getNativeBundle:()=>bundle}).getOpenCodeResolutionSnapshot()).toThrow('native_runtime_bundle_required');
});
