import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readBundleJSON} from '../../packages/web/server/lib/opencode/runtime-host/bundle-migration-inventory.js';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import {seedNativeSetup} from '../../packages/web/server/lib/opencode/runtime-host/native-setup-seed.js';
import {relocateNativeSetupProfiles} from '../../packages/web/server/lib/opencode/runtime-host/native-setup-profiles.js';
import {resolveNativeProviderConfiguration} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-configuration.js';
import {claudeKeychainService} from '../../packages/web/server/lib/opencode/claude-credential-projection.js';
import {verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {runNativeBundleCredentialProcess,NATIVE_BUNDLE_CREDENTIAL_CONTRACT as protocol} from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-process.js';
import {emptyClaudeLifecycle,parseClaudeLifecycle,hasLegacyClaudeFence,claudeRecordFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import {createNativeClaudeCredentialOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-runtime-owner.js';
import {loadReviewedClaudeCredentials} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-host-credentials.js';
import {createOpenAiOAuthCoordinator} from '../../packages/web/server/lib/opencode/openai-oauth-coordinator.js';
import {assertQaNativeCredentialAdmission} from './native-profile-preparation.mjs';
import {createQaHostLaunchEnvironment} from './launch-environment.mjs';
import {readQaPinnedFile} from './live-setup-mirror.mjs';

const cache=fileURLToPath(new URL('../../.cache/',import.meta.url)).replace(/\/$/,'');
const profileID='qa-independent-cli';
const fail=code=>Object.assign(new Error(code),{code});
const forbidden=()=>{throw fail('qa_access_only_mutation_or_network_forbidden');};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,directory)=>directory.startsWith(root+path.sep);
async function privateDirectory(directory){
  if(!path.isAbsolute(directory??'')||!inside(cache,directory)||await fs.realpath(directory)!==directory)throw fail('qa_access_only_private_path_required');
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid?.())throw fail('qa_access_only_private_path_required');
}
const verifyBinding=binding=>{
  if(!isDeepStrictEqual(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:binding.controlRoot}),binding))throw fail('qa_access_only_selection_changed');
};
const verifyArtifactsFor=(binding,verify)=>{
  const launch=binding.descriptor.launch;
  return verify({manifestPath:launch.artifactManifestPath,manifestSha256:launch.artifactManifestSha256,
    launcher:path.join(path.dirname(launch.artifactManifestPath),`DevRyan-execution-${process.platform}-${process.arch}`)});
};

/** Seed a nonsecret profile through the configuration owners during migration.
 * Source and each cell have empty account directories. Only the service name is
 * shared; the independent vendor login stays in its selected platform store. */
export async function prepareAccessOnlyAnthropicSource(source,{keychainService}={}){
  const sourceHome=source.launch.global.home;
  await privateDirectory(sourceHome);
  if(keychainService!==undefined&&!/^Claude Code-credentials-[a-f0-9]{8}$/.test(keychainService))throw fail('qa_access_only_service_invalid');
  const seedHome=path.join(sourceHome,'.qa-auth-seed'),empty=path.join(seedHome,'.qa-empty-cli-account'),data=path.join(seedHome,'opencode-data');
  await fs.mkdir(seedHome,{mode:0o700});await fs.mkdir(empty,{mode:0o700});await fs.mkdir(data,{mode:0o700});
  const checkEmpty=async()=>{await privateDirectory(empty);if((await fs.readdir(empty)).length)throw fail('qa_access_only_seed_not_empty');};
  await checkEmpty();
  return {...source,runMigration:async request=>{
    await checkEmpty();
    const runtimeRoot=path.dirname(path.dirname(path.dirname(sourceHome))),bundleRoot=path.dirname(request.isolatedRoot);
    if(request.protocol!=='devryan-native-migration/1'||!inside(runtimeRoot,bundleRoot)||await fs.realpath(bundleRoot)!==bundleRoot)throw fail('qa_access_only_target_invalid');
    const draftFile=path.join(bundleRoot,'sources/preparation.json'),before=await readQaPinnedFile(draftFile,undefined,32*1024*1024),draft=await readBundleJSON(draftFile),target=draft.descriptor?.launch;
    if(!isDeepStrictEqual(draft.request,request)||draft.descriptor.bundleID!==request.bundleID||target?.opencodeDatabasePath!==request.candidateDatabasePath
      ||path.dirname(target.global.home)!==request.isolatedRoot)throw fail('qa_access_only_target_invalid');
    const initial={id:profileID,type:'claude-max',claudeConfigDir:empty};
    const proposed=await relocateNativeSetupProfiles({profiles:[initial],sourceHome:seedHome,targetHome:target.global.home,copyAccount:async account=>{if(account!==empty)throw fail('qa_access_only_seed_not_empty');}});
    const service=keychainService??claudeKeychainService(proposed[0].claudeConfigDir,target.global.home);
    await seedNativeSetup({source:{home:seedHome,webDataDirectory:source.launch.webDataDirectory,webConfigDirectory:source.launch.webConfigDirectory,
      opencodeConfigDirectory:source.launch.opencodeConfigDirectory,opencodeDataDirectory:data},target,
      environment:{MERIDIAN_PROFILES:JSON.stringify([{...initial,keychainService:service}]),MERIDIAN_DEFAULT_PROFILE:profileID}});
    await checkEmpty();if(!(await readQaPinnedFile(draftFile,undefined,32*1024*1024)).equals(before))throw fail('qa_access_only_target_changed');
    const configuration=await resolveNativeProviderConfiguration({globals:target.global,environment:{}});
    if(!isDeepStrictEqual(configuration.profiles,[{...proposed[0],keychainService:service}])||configuration.defaultProfile!==profileID)throw fail('qa_access_only_configuration_changed');
    await privateDirectory(proposed[0].claudeConfigDir);
    if((await fs.readdir(proposed[0].claudeConfigDir)).length)throw fail('qa_access_only_target_not_empty');
    return source.runMigration(request);
  }};
}

/** The only store injection is a constructor used by the synthetic rehearsal.
 * Live entrypoints always use the sealed reviewed module and artifact verifier. */
export function createAccessOnlyAnthropic({sourceBinding,loadReviewedModule=loadReviewedClaudeCredentials,credentialProcess=runNativeBundleCredentialProcess,verifyArtifacts=verifyNativeRuntimeArtifacts}){
  if(!sourceBinding?.descriptor?.bundleID||!sourceBinding.controlRoot||[loadReviewedModule,credentialProcess,verifyArtifacts].some(callback=>typeof callback!=='function'))throw fail('qa_access_only_binding_required');
  const source=structuredClone(sourceBinding),coordinator=createOpenAiOAuthCoordinator({readAuth:forbidden,compareAndSwap:forbidden,fetchImpl:forbidden});
  let sourceService,verifiedRecordFingerprint,verifiedConfigurationFingerprint;
  const configurationFor=async binding=>{
    verifyBinding(binding);await privateDirectory(binding.controlRoot);await privateDirectory(binding.descriptor.launch.global.home);
    const configuration=await resolveNativeProviderConfiguration({globals:binding.descriptor.launch.global,environment:{},controlRoot:binding.controlRoot});
    const expectedDirectory=path.join(binding.descriptor.launch.global.home,'.config/meridian/accounts',hash(profileID));
    const profile=configuration.profiles[0];
    if(configuration.profiles.length!==1||configuration.defaultProfile!==profileID||profile?.id!==profileID||profile.type!=='claude-max'
      ||profile.claudeConfigDir!==expectedDirectory||Object.keys(profile).some(key=>!['id','type','claudeConfigDir','keychainService'].includes(key))
      ||!/^Claude Code-credentials-[a-f0-9]{8}$/.test(profile.keychainService??''))throw fail('qa_access_only_configuration_changed');
    await privateDirectory(expectedDirectory);
    const service=sourceService??claudeKeychainService(expectedDirectory,binding.descriptor.launch.global.home);
    if(profile.keychainService!==service)throw fail('qa_access_only_service_changed');
    return configuration;
  };
  const admit=async({binding,assertHeld,timeoutMs,recordSecret},verifyLogin)=>{
    if(typeof assertHeld!=='function')throw fail('qa_access_only_checkpoint_required');
    await assertHeld();const configuration=await configurationFor(binding),configurationFingerprint=hash(JSON.stringify(configuration));
    if(!verifyLogin&&!verifiedRecordFingerprint)throw fail('qa_access_only_login_unverified');
    let observedFingerprint;
    const check=async()=>{
      await assertHeld();verifyBinding(source);const current=await configurationFor(binding);
      if(hash(JSON.stringify(current))!==configurationFingerprint)throw fail('qa_access_only_configuration_changed');
      if(verifiedConfigurationFingerprint&&hash(JSON.stringify(await configurationFor(source)))!==verifiedConfigurationFingerprint)throw fail('qa_access_only_configuration_changed');await assertHeld();
    };
    const readLifecycle=async()=>{
      await check();const captured=await credentialProcess({descriptor:binding.descriptor,assertHeld:check,action:{protocol,action:'capture'}});
      const state=captured.snapshot.claudeLifecycle===null?emptyClaudeLifecycle():parseClaudeLifecycle(captured.snapshot.claudeLifecycle);
      if(state.revision!==0||state.accounts.length||state.unresolved.length)throw fail('qa_access_only_enrollment_or_fence_present');await check();return state;
    };
    await readLifecycle();const artifacts=await verifyArtifactsFor(binding,verifyArtifacts),module=await loadReviewedModule(artifacts.reviewedClaudeCredentials);
    const readonly={...module,ensureFreshToken:forbidden,refreshOAuthToken:forbidden,createPlatformCredentialStore:options=>{
      const store=module.createPlatformCredentialStore({...options,fetch:forbidden});
      return {...store,write:forbidden,read:async()=>{
        await check();const value=await store.read();await check();
        if(!value||hasLegacyClaudeFence(value))throw fail('qa_access_only_legacy_fence_or_missing');
        const fingerprint=claudeRecordFingerprint(value);
        if(observedFingerprint&&fingerprint!==observedFingerprint||verifiedRecordFingerprint&&fingerprint!==verifiedRecordFingerprint)throw fail('qa_access_only_login_changed');
        observedFingerprint=fingerprint;
        for(const key of ['accessToken','refreshToken'])if(recordSecret&&typeof value.claudeAiOauth?.[key]==='string')recordSecret(value.claudeAiOauth[key]);
        return value;
      }};
    }};
    const owner=createNativeClaudeCredentialOwner({profiles:configuration.profiles,home:binding.descriptor.launch.global.home,
      withMutationQueue:action=>coordinator.withAuthMutation(action),asset:artifacts.reviewedClaudeCredentials,loadModule:async()=>readonly,policy:'access-only',
      backend:{fetch:forbidden},lifecycle:{read:readLifecycle,transition:forbidden}});
    const row=await owner({profileID,purpose:'request'},{recheck:check,retried:new Set(),readOnly:true},async value=>{
      const proof={kind:'meridian-profile',providerId:'anthropic',bundleID:binding.descriptor.bundleID,controlRoot:binding.controlRoot,profileID,authKind:'claude-max',configurationFingerprint,expires:value.expiresAt};
      return assertQaNativeCredentialAdmission('anthropic',{anthropic:proof},timeoutMs);
    });
    await readLifecycle();await check();
    if(verifyLogin){verifiedRecordFingerprint=observedFingerprint;verifiedConfigurationFingerprint=configurationFingerprint;sourceService=configuration.profiles[0].keychainService;}
    return {anthropic:row};
  };
  return Object.freeze({
    verifyLogin:input=>{
      if(!isDeepStrictEqual(input.binding,source))throw fail('qa_access_only_selection_changed');
      return admit(input,true);
    },
    admitCandidate:input=>admit(input,false),
    prepareCandidateSource:async sourcePreparation=>{
      if(!sourceService)throw fail('qa_access_only_login_unverified');
      return prepareAccessOnlyAnthropicSource(sourcePreparation,{keychainService:sourceService});
    },
    loginCommand:async workspace=>{
      const configuration=await configurationFor(source),launch=source.descriptor.launch,artifacts=await verifyArtifactsFor(source,verifyArtifacts);
      const environment=createQaHostLaunchEnvironment({HOME:launch.global.home,XDG_CONFIG_HOME:launch.global.config,XDG_DATA_HOME:launch.global.data,
        XDG_STATE_HOME:launch.global.state,XDG_CACHE_HOME:launch.global.cache,TMPDIR:launch.global.tmp,CLAUDE_CONFIG_DIR:configuration.profiles[0].claudeConfigDir,
        GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'});
      return 'cd '+quote(workspace)+' && env -i '+Object.entries(environment).map(([key,value])=>key+'='+quote(value)).join(' ')+' '+quote(artifacts.reviewedClaude.claude.path)+' auth login';
    },
  });
}
