import {isDeepStrictEqual} from 'node:util';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import {createRuntimeBundleCheckpoint} from '../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import {runNativeBundleCredentialProcess,NATIVE_BUNDLE_CREDENTIAL_CONTRACT as protocol} from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-process.js';
import {nativeBundleCredentialFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';
import {credentialMutationFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import {emptyClaudeLifecycle,parseClaudeLifecycle} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import {assertQaNativeCredentialAdmission} from './native-profile-preparation.mjs';
import {createCredentialLeakProbe} from './credential-leak-probe.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const nativeProviders=new Set(['openai','xai','opencode','opencode-go','cursor-acp']);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const sameBinding=binding=>{
  if(!isDeepStrictEqual(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:binding.controlRoot}),binding))throw fail('qa_held_source_selection_changed');
};
function requiredNative(requiredProviders){
  if(!Array.isArray(requiredProviders)||!requiredProviders.length||new Set(requiredProviders).size!==requiredProviders.length
    ||requiredProviders.some(provider=>provider!=='anthropic'&&!nativeProviders.has(provider)))throw fail('qa_held_source_provider_invalid');
  return requiredProviders.filter(provider=>provider!=='anthropic');
}
function rowsFor(captured,binding,requiredProviders,timeoutMs,recordSecret){
  if(captured?.protocol!==protocol||captured.status!=='captured'||captured.snapshot?.protocol!==protocol
    ||nativeBundleCredentialFingerprint(captured.snapshot)!==captured.sha256||!Array.isArray(captured.snapshot.credentials))throw fail('qa_held_source_snapshot_invalid');
  const state=captured.snapshot.claudeLifecycle===null?emptyClaudeLifecycle():parseClaudeLifecycle(captured.snapshot.claudeLifecycle);
  if(state.revision!==0||state.accounts.length||state.unresolved.length)throw fail('qa_held_source_claude_enrollment_present');
  if(recordSecret)for(const row of captured.snapshot.credentials)for(const key of ['key','access','refresh']){
    if(typeof row.value?.[key]==='string'&&row.value[key])recordSecret(row.value[key]);
  }
  return Object.fromEntries(requiredNative(requiredProviders).map(provider=>{
    const selected=captured.snapshot.credentials.filter(row=>row.integrationID===provider&&row.active===true);
    if(selected.length!==1)throw fail('qa_held_source_credential_prerequisite');
    const row=selected[0];
    if(typeof row.id!=='string'||typeof row.label!=='string'||!['key','oauth'].includes(row.value?.type))throw fail('qa_held_source_snapshot_invalid');
    // Credential.Info excludes the SQL active flag. This is the controller's
    // metadata API fingerprint, not the value-only fingerprint of older QA.
    const expectedFingerprint=credentialMutationFingerprint({id:row.id,integrationID:row.integrationID,label:row.label,value:row.value});
    const admission={kind:'native-credential',providerId:provider,bundleID:binding.descriptor.bundleID,controlRoot:binding.controlRoot,
      credentialID:row.id,expectedFingerprint,valueType:row.value.type,...row.value.type==='oauth'?{expires:row.value.expires}:{}};
    return [provider,assertQaNativeCredentialAdmission(provider,{[provider]:admission},timeoutMs)];
  }));
}

/** All authority is constructor-owned and private. The source is held once;
 * every cell projects into a never-started candidate through native CAS. */
export function createHeldSourceCredentials({grant,sourceBinding,credentialProcess=runNativeBundleCredentialProcess,verifyAdditionalCredentials,admitCandidate}){
  if(!sourceBinding?.descriptor?.bundleID||!sourceBinding.controlRoot||typeof grant?.withHeldCheckpoint!=='function'||grant.ownerID!==sourceBinding.descriptor.bundleID||grant.controlRoot!==sourceBinding.controlRoot
    ||typeof credentialProcess!=='function')throw fail('qa_held_source_owner_required');
  const source=freeze(structuredClone(sourceBinding)),probe=createCredentialLeakProbe();
  let verifiedSha256,verifiedRows,verifiedProviders;
  const held=action=>grant.withHeldCheckpoint(async({assertHeld})=>{
    if(typeof assertHeld!=='function')throw fail('qa_held_source_unavailable');
    const check=async()=>{await assertHeld();sameBinding(source);await assertHeld();};
    await check();const result=await action(check);await check();return result;
  });
  const capture=(binding,assertHeld)=>credentialProcess({descriptor:binding.descriptor,assertHeld,action:{protocol,action:'capture'}});
  return Object.freeze({
    verify:async({requiredProviders,timeoutMs})=>{
      requiredNative(requiredProviders);
      if(verifiedSha256)throw fail('qa_held_source_already_verified');
      const rows=await held(async assertHeld=>{
        const captured=await capture(source,assertHeld),native=rowsFor(captured,source,requiredProviders,timeoutMs,probe.record);
        const additional=requiredProviders.includes('anthropic')?await verifyAdditionalCredentials?.({binding:source,assertHeld,timeoutMs,recordSecret:probe.record}):{};
        if(requiredProviders.includes('anthropic')&&!additional?.anthropic)throw fail('qa_held_source_credential_prerequisite');
        const rows={...native,...additional};
        if(Object.keys(rows).some(provider=>!requiredProviders.includes(provider)))throw fail('qa_held_source_credential_prerequisite');
        for(const provider of requiredProviders){
          if(rows[provider]?.bundleID!==source.descriptor.bundleID||rows[provider].controlRoot!==source.controlRoot)throw fail('qa_native_credential_binding');
          rows[provider]=assertQaNativeCredentialAdmission(provider,rows,timeoutMs);
        }
        await assertHeld();return {sha256:captured.sha256,admission:freeze(rows)};
      });
      // A failed final settlement must not leave a usable verification behind.
      verifiedSha256=rows.sha256;verifiedRows=rows.admission;verifiedProviders=Object.freeze([...requiredProviders]);
      return verifiedRows;
    },
    bootstrap:async({binding,requiredProviders,preparedSource,cellTimeoutMs})=>{
      if(!verifiedSha256||!isDeepStrictEqual(requiredProviders,verifiedProviders))throw fail('qa_held_source_unverified');
      if(typeof preparedSource?.checkpointOptions!=='function'||binding.descriptor.bundleID===source.descriptor.bundleID)throw fail('qa_held_source_candidate_invalid');
      return held(async assertSourceHeld=>{
        const captured=await capture(source,assertSourceHeld),sourceRows=rowsFor(captured,source,requiredProviders,cellTimeoutMs);
        if(captured.sha256!==verifiedSha256)throw fail('qa_held_source_changed');
        const candidate=freeze(structuredClone(binding)),launch=candidate.descriptor.launch,ownerID=candidate.descriptor.bundleID;
        sameBinding(candidate);const options=await preparedSource.checkpointOptions({ownerID,generation:2,launch});
        if(options.neverStarted!==true)throw fail('qa_held_source_candidate_not_never_started');
        const checkpoint=createRuntimeBundleCheckpoint({...options,ownerID,generation:2,launch});
        return checkpoint({kind:'bundle',bundleID:ownerID},async(_stamp,{assertHeld})=>{
          const check=async()=>{await assertSourceHeld();await assertHeld();sameBinding(candidate);await assertHeld();await assertSourceHeld();};
          await check();const baseline=await capture(candidate,check);
          rowsFor(baseline,candidate,['anthropic'],cellTimeoutMs);
          const credentialBinding={sourceBundleID:source.descriptor.bundleID,targetBundleID:ownerID,targetManifestSha256:launch.artifactManifestSha256,expectedTargetSha256:baseline.sha256,sourceSha256:captured.sha256};
          const receipt=await credentialProcess({descriptor:candidate.descriptor,assertHeld:check,action:{protocol,action:'project',source:captured.snapshot,binding:credentialBinding}});
          if(receipt?.protocol!==protocol||receipt.status!=='projected'||receipt.appliedSha256!==captured.sha256
            ||Object.entries(credentialBinding).some(([key,value])=>receipt[key]!==value))throw fail('qa_held_source_projection_unverified');
          const after=await capture(candidate,check),rows=rowsFor(after,candidate,requiredProviders,cellTimeoutMs);
          if(after.sha256!==captured.sha256||Object.entries(rows).some(([provider,row])=>row.credentialID!==sourceRows[provider]?.credentialID
            ||row.expectedFingerprint!==verifiedRows[provider]?.expectedFingerprint))throw fail('qa_held_source_projection_unverified');
          const additional=requiredProviders.includes('anthropic')?await admitCandidate?.({binding:candidate,assertHeld:check,timeoutMs:cellTimeoutMs}):{};
          if(requiredProviders.includes('anthropic')&&!additional?.anthropic)throw fail('qa_held_source_credential_prerequisite');
          const credentials={...rows,...additional};
          if(Object.keys(credentials).some(provider=>!requiredProviders.includes(provider)))throw fail('qa_held_source_credential_prerequisite');
          for(const provider of requiredProviders){
            if(credentials[provider]?.bundleID!==ownerID||credentials[provider].controlRoot!==candidate.controlRoot)throw fail('qa_native_credential_binding');
            credentials[provider]=assertQaNativeCredentialAdmission(provider,credentials,cellTimeoutMs);
          }
          await check();return freeze({status:'ready',credentials});
        });
      });
    },
    createLeakProbe:()=>{
      if(!verifiedSha256)throw fail('qa_held_source_unverified');
      return Object.freeze({scan:probe.scan});
    },
  });
}
