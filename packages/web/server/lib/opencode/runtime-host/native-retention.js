const fail=code=>Object.assign(new Error(code),{code,status:409,statusCode:409});
const ids=members=>members.map(row=>row.id).sort();
const same=(left,right)=>JSON.stringify(ids(left))===JSON.stringify(ids(right));
/** Automatic cleanup uses the existing admission owner and durable removal
 * coordinator. Quiet acquisition grants no execution/cancellation capability. */
export function createNativeRetention({admissionOwner,controller,removal,runtime,ownerID}){
 return {
  run:async({directory,sessionID,action,at,members,authorize})=>{
   if(!['archive','delete'].includes(action)||!Array.isArray(members)||!members.length||members.length>512||typeof authorize!=='function')throw fail('native_retention_scope_invalid');
   return admissionOwner.withRetentionOperation({directory,sessionID,action,at,members,authorize},async permit=>{
    const held=await controller().call({action:'acquire-retention-owned',sessionID,permit});
    if(!held?.held||!same(held.members,members))throw fail('native_retention_tree_changed');
    await authorize(held.members);
    if(action==='delete')return removal.remove({sessionID,directory,quiet:true});
    const result=await controller().call({action:'archive-retention-owned',sessionID,at,permit});
    if(result?.archived!==true||!same(result.members,members))throw fail('native_retention_archive_uncertain');
    return true;
   });
  },
  recover:async({directory,instanceID})=>{
   // An uncommitted automatic decision is abandoned, never replayed. A
   // committed quiet removal retains the existing removal recovery contract.
   for(const intent of await runtime.nativeRemovals({directory}))if(intent.ownerID===ownerID&&intent.quiet&&intent.state==='preparing')
    await runtime.abandonQuietNativeRemoval({directory,intentID:intent.id,ownerID});
   for(const hold of await runtime.nativeRetentionHolds({directory,ownerID})){
    if(hold.retentionInstanceID===instanceID)throw fail('native_retention_in_progress');
    await runtime.releaseNativeAdmission({directory,sessionID:hold.sessionID,ownerID,holdID:hold.id,expectedRevision:hold.revision});
   }
  },
 };
}
