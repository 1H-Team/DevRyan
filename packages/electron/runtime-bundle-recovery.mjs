const fail=code=>Object.assign(new Error(code),{code});

/** A recovery page receives no HTTP mutation authority. Its main-frame IPC
 * uses the captured local runtime handle and the same revision-checked owner. */
export async function confirmRuntimeBundleResume({args,handle,assertSender,confirm}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1
  ||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<1)throw fail('bundle_selection_revision_conflict');
 const check=async()=>{
  assertSender();
  if(typeof handle?.runtimeBundle?.resume!=='function')throw fail('bundle_recovery_owner_required');
  const status=await handle.runtimeBundle.inspect();assertSender();
  if(status?.state!=='held'||status.reconciliationRequired!==true||status.revision!==args.expectedRevision)throw fail('bundle_selection_revision_conflict');
  if(status.resumeAvailable!==true)throw fail('bundle_recovery_proof_required');
 };
 await check();
 if(await confirm()!==true)return {state:'cancelled'};
 await check();
 return handle.runtimeBundle.resume({expectedRevision:args.expectedRevision});
}
