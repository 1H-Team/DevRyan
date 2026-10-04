import path from 'node:path';
import type * as ReviewedSlim from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
export interface NativeSlimPathOwners {
 readonly assertCurrent:(input:ReviewedSlim.ReviewedSlimToolInput)=>Promise<void>;
 readonly stat:(input:ReviewedSlim.ReviewedSlimToolInput,file:string)=>Promise<{readonly kind:'file'|'directory'|'other'}>;
 readonly realpath:(input:ReviewedSlim.ReviewedSlimToolInput,file:string)=>Promise<string>;
 readonly readText:(input:ReviewedSlim.ReviewedSlimToolInput,file:string)=>Promise<string>;
}
/** Original algorithms, ordered exactly as the package; every IO keeps this hook's fresh authority. */
export function createReviewedSlimPathHooks(input:{readonly originals:typeof ReviewedSlim;readonly directory:string;readonly worktree?:string;readonly owners:NativeSlimPathOwners}){
 if(!path.isAbsolute(input.directory)||path.resolve(input.directory)!==input.directory)throw new Error('native_slim_path_location_invalid');
 for(const key of ['assertCurrent','stat','realpath','readText'] as const)if(typeof input.owners[key]!=='function')throw new Error('native_slim_path_owner_required');
 const apply=input.originals.createApplyPatchHook(input),rescue=input.originals.createAbsolutePathRescueHook(input),search=input.originals.createSearchPathGuardHook({directory:input.directory,hostFlavor:'v2'});
 return {before:async(event:ReviewedSlim.ReviewedSlimToolInput,output:ReviewedSlim.ReviewedSlimToolOutput)=>{
  if(event.directory!==undefined&&event.directory!==input.directory)throw new Error('native_slim_path_location_mismatch');
  const checked=async<T>(action:()=>Promise<T>)=>{await input.owners.assertCurrent(event);try{return await action();}finally{await input.owners.assertCurrent(event);}};
  await input.owners.assertCurrent(event);
  try{await input.originals.withReviewedSlimPathOwner({
   stat:file=>checked(async()=>{const view=await input.owners.stat(event,file);return {isFile:()=>view.kind==='file'};}),
   realpath:file=>checked(()=>input.owners.realpath(event,file)),readText:file=>checked(()=>input.owners.readText(event,file)),
  },async()=>{await apply['tool.execute.before'](event,output);await rescue['tool.execute.before'](event,output);await search['tool.execute.before'](event,output);});}
  finally{await input.owners.assertCurrent(event);}
 }};
}
