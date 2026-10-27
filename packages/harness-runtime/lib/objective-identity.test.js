import {expect,test} from 'bun:test';
import {isManagedMaintenancePrompt} from './objective-identity.js';

test('result-ready collection retains the objective only for its exact synthetic marker',()=>{
 const part={type:'text',synthetic:true,text:'[devryan-managed-result-ready:v1]\nCollect the assigned result.'};
 expect(isManagedMaintenancePrompt({parts:[part]})).toBe(true);
 expect(isManagedMaintenancePrompt({parts:[{...part,synthetic:false}]})).toBe(false);
 expect(isManagedMaintenancePrompt({parts:[{...part,text:'Quoted '+part.text}]})).toBe(false);
 expect(isManagedMaintenancePrompt({parts:[part,{type:'text',synthetic:true,text:'[devryan-plan-action:v1] {}'}]})).toBe(false);
});
