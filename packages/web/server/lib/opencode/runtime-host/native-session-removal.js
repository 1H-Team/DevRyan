const fail = code => Object.assign(new Error(code), {code,status:409,statusCode:409});
const sameMembers = (left,right) => JSON.stringify([...left].sort((a,b)=>a.id.localeCompare(b.id))) === JSON.stringify([...right].sort((a,b)=>a.id.localeCompare(b.id)));
const checkedSnapshot = (value, directory) => {
  if (!value || !Array.isArray(value.members) || !Array.isArray(value.states) || value.members.length > 10000
    || value.members.some(member=>typeof member.id!=='string' || member.directory!==directory)
    || new Set(value.members.map(member=>member.id)).size!==value.members.length
    || value.states.some(state=>typeof state.sessionID!=='string' || typeof state.exists!=='boolean' || typeof state.active!=='boolean'
      || typeof state.claimed!=='boolean' || !Array.isArray(state.inboxIDs) || !Array.isArray(state.pendingIDs))) throw fail('native_removal_tree_invalid');
  return value;
};

/** Owns an exact terminal decision in the existing mutation ledger. Native
 * removal owns conversation disposal; this coordinator never removes files. */
export function createNativeSessionRemoval(options) {
  const {runtime,admissionOwner,ownerID,inspectRemovalOwned,removeLeafOwned,cancelManaged,cancelAndWait}=options;
  const pending=new Map();
  const scoped=(intent,sessionID,action)=>admissionOwner.withRemovalOperation({directory:intent.directory,intentID:intent.id,sessionID},action);
  const inspect=(intent,sessionID=intent.rootSessionID)=>scoped(intent,sessionID,permit=>inspectRemovalOwned({sessionID,permit}));
  const settle=async(intent,members,absentSessions=[])=>{
    const sessions=members.map(member=>member.id),scope={directory:intent.directory,sessions,intentID:intent.id};
    const fence=await cancelManaged({...scope,phase:'fence'});
    if(fence?.fenced!==true || sessions.some(id=>!fence.sessions?.includes(id))) throw fail('native_removal_managed_unconfirmed');
    const live=sessions.filter(id=>!absentSessions.includes(id));
    const receipt=live.length?await cancelAndWait({directory:intent.directory,sessions:live}):null;
    if(live.length && (receipt?.terminated!==true || live.some(id=>!receipt.sessions?.includes(id)))) throw fail('native_removal_settlement_uncertain');
    const disposition=await cancelManaged({...scope,phase:'settle',settled:receipt,absentSessions});
    if(disposition?.settled!==true || sessions.some(id=>!disposition.sessions?.includes(id))) throw fail('native_removal_managed_unconfirmed');
  };
  const finish=async intent=>{
    if(intent.state!=='committed') throw fail('native_removal_not_committed');
    const survivors=intent.members.filter(member=>!intent.removed.includes(member.id));
    // Reconcile a lost delete ACK against the original durable member set.
    const before=checkedSnapshot(await inspect(intent),intent.directory);
    const expected=intent.members.filter(member=>before.members.some(actual=>actual.id===member.id));
    if(!sameMembers(before.members,expected.map(({generation:_generation,...member})=>member))) throw fail('native_removal_tree_changed');
    const absent=intent.members.filter(member=>!before.members.some(actual=>actual.id===member.id)).map(member=>member.id);
    if(absent.some(id=>!intent.dispositions.some(row=>row.sessionID===id))
      || (await runtime.activeLeases({directory:intent.directory,sessions:absent})).length) throw fail('native_removal_settlement_uncertain');
    for(const sessionID of absent) {
      const snapshot=checkedSnapshot(await inspect(intent,sessionID),intent.directory);
      const state=snapshot.states.find(row=>row.sessionID===sessionID);
      if(snapshot.members.length || !state || state.exists || state.active || state.claimed || state.inboxIDs.length || state.pendingIDs.length) {
        throw fail('native_removal_settlement_uncertain');
      }
    }
    if(intent.quiet){if(before.states.some(row=>row.active||row.claimed||row.inboxIDs.length||row.pendingIDs.length))throw fail('native_retention_session_active');}
    else await settle(intent,intent.members,absent);
    const byID=new Map(intent.members.map(member=>[member.id,member]));
    const depth=member=>{let count=0;const seen=new Set();while(member.id!==intent.rootSessionID){
      if(seen.has(member.id) || !byID.has(member.parentID)) throw fail('native_removal_tree_invalid');
      seen.add(member.id);member=byID.get(member.parentID);count++;
    }return count;};
    for(const member of [...survivors].sort((a,b)=>depth(b)-depth(a))) {
      const observed=checkedSnapshot(await inspect(intent,member.id),intent.directory);
      if(observed.members.some(row=>row.id!==member.id) || observed.states.some(state=>state.active || state.claimed)) throw fail('native_removal_tree_changed');
      const state=observed.states.find(row=>row.sessionID===member.id);
      if(!state) throw fail('native_removal_observation_unavailable');
      let disposition=intent.dispositions.find(row=>row.sessionID===member.id);
      if(state.exists) {
        disposition={sessionID:member.id,inboxIDs:state.inboxIDs,pendingIDs:state.pendingIDs};
        intent=await runtime.stageNativeRemovalMember({directory:intent.directory,intentID:intent.id,ownerID,...disposition});
      } else if(!disposition) throw fail('native_removal_disposition_missing');
      const result=await scoped(intent,member.id,permit=>removeLeafOwned({intentID:intent.id,sessionID:member.id,permit}));
      if(result?.removed!==true || result.sessionID!==member.id) throw fail('native_removal_unconfirmed');
      intent=await runtime.acknowledgeNativeRemoval({directory:intent.directory,intentID:intent.id,ownerID,...disposition});
    }
    await runtime.completeNativeRemoval({directory:intent.directory,intentID:intent.id,ownerID});
    return true;
  };
  const remove=async({sessionID,directory,quiet=false})=>{
    if(pending.has(sessionID)) throw fail('native_removal_in_progress');
    const work=(async()=>{
      const grant=await admissionOwner.captureRemovalAuthorization(sessionID);
      if(directory!==undefined && directory!==grant.session.directory) throw fail('native_session_directory_mismatch');
      directory=grant.session.directory;
      if(quiet&&!grant.quietHold)throw fail('native_retention_hold_required');
      let intent=await runtime.beginNativeRemoval({directory,rootSessionID:sessionID,ownerID,...(quiet?{quietHold:grant.quietHold}:{})});
      if(quiet){if(!grant.quietHold||!intent.quiet)throw fail('native_retention_hold_required');grant.transferQuietHold(intent.id);}
      if(intent.state==='committed') return finish(intent);
      // The root hold also fences descendants. Already admitted effects must
      // settle before the final canonical tree can become a durable decision.
      const initial=checkedSnapshot(await inspect(intent),directory);
      if(!initial.members.some(member=>member.id===sessionID)) throw fail('native_removal_root_missing');
      intent=await runtime.prepareNativeRemovalMembers({directory,intentID:intent.id,ownerID,members:initial.members});
      if(quiet){if(initial.states.some(row=>row.active||row.claimed||row.inboxIDs.length||row.pendingIDs.length))throw fail('native_retention_session_active');}
      else await settle(intent,initial.members);
      await grant.drain();
      const final=checkedSnapshot(await inspect(intent),directory);
      if(!sameMembers(initial.members,final.members) || final.states.some(state=>state.active || state.claimed || quiet&&(state.inboxIDs.length||state.pendingIDs.length))) throw fail('native_removal_tree_changed');
      await grant.reauthorize();
      intent=await runtime.commitNativeRemoval({directory,intentID:intent.id,ownerID,members:final.members,beforeCommit:grant.reauthorize});
      return finish(intent);
    })();
    pending.set(sessionID,work);
    try{return await work;}finally{if(pending.get(sessionID)===work)pending.delete(sessionID);}
  };
  return {remove,recover:async({directory})=>{
    for(const intent of await runtime.nativeRemovals({directory})) {
      if(intent.ownerID!==ownerID) continue;
      if(intent.state==='preparing'&&intent.quiet){await runtime.abandonQuietNativeRemoval({directory,intentID:intent.id,ownerID});continue;}
      if(intent.state==='preparing') {
        const result=await cancelManaged({directory,sessions:intent.members.map(member=>member.id),intentID:intent.id,phase:'fence'});
        if(result?.fenced!==true || intent.members.some(member=>!result.sessions?.includes(member.id))) throw fail('native_removal_managed_unconfirmed');
        continue;
      }
      if(pending.has(intent.rootSessionID)) throw fail('native_removal_in_progress');
      const work=finish(intent);pending.set(intent.rootSessionID,work);
      try{await work;}finally{pending.delete(intent.rootSessionID);}
    }
  }};
}
