import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatPackagedAgentSyncConflicts } from './packaged-agent-sync.js';
import { DEFAULT_AGENT_RUNTIME_SETTINGS, normalizeAgentRuntimeSettings } from './agent-runtime-settings.js';
import { buildVisibleSkillPolicy } from './skill-policy.js';
import { SLIM_REPLACED_AGENT_NAMES, resolveSlimConfig } from './slim-config.js';
import { probe as probeOpenCodeRuntime } from './readiness-probe.js';
import { SUPPORTED_NATIVE_OPENCODE_VERSIONS } from './version-policy.js';

const unavailable=(code='native_runtime_bundle_required')=>Object.assign(new Error(code==='native_runtime_owner_mismatch'?'Inherited runtime process requires a fresh server owner':'Verified native runtime bundle required'),{code,status:503});
function normalizeWorkingDirectoryCandidate(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function isExistingDirectory(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveManagedWorkingDirectoryFromSettings(settings, fallbackDirectory, sanitizeProjects) {
  const candidates = [];
  const lastDirectory = normalizeWorkingDirectoryCandidate(settings?.lastDirectory);
  if (lastDirectory) {
    candidates.push(lastDirectory);
  }

  const projects = typeof sanitizeProjects === 'function'
    ? sanitizeProjects(settings?.projects)
    : (Array.isArray(settings?.projects) ? settings.projects : []);
  const activeProjectId = typeof settings?.activeProjectId === 'string' ? settings.activeProjectId : '';
  const activeProject = Array.isArray(projects)
    ? projects.find((project) => project?.id === activeProjectId)
    : null;
  const activeProjectDirectory = normalizeWorkingDirectoryCandidate(activeProject?.path);
  if (activeProjectDirectory) {
    candidates.push(activeProjectDirectory);
  }

  if (Array.isArray(projects)) {
    for (const project of projects) {
      const projectDirectory = normalizeWorkingDirectoryCandidate(project?.path);
      if (projectDirectory) {
        candidates.push(projectDirectory);
      }
    }
  }

  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }

  return normalizeWorkingDirectoryCandidate(fallbackDirectory) || os.homedir();
}

/** Lifecycle never discovers or starts an ambient OpenCode executable. */
export const createOpenCodeLifecycleRuntime = (deps) => {
  const {state,env={},syncToHmrState=()=>{},syncFromHmrState=()=>{},buildOpenCodeUrl,getOpenCodeAuthHeaders=()=>({}),
    setOpenCodePort=port=>{state.openCodePort=port;},setDetectedOpenCodeApiPrefix=()=>{},setupProxy=()=>{},ensureOpenCodeApiPrefix=()=>{},
    pauseManagedBrowserLeases=async()=>null,resumeManagedBrowserLeases=async()=>{},getActiveSessionCount=()=>0,
    syncPackagedAgents=async()=>({changed:false}),syncRuntimeAgentOverlays=async()=>({changed:false}),
    readSettingsFromDisk=async()=>({}),readAgentRuntimeSettings=()=>DEFAULT_AGENT_RUNTIME_SETTINGS,
    sanitizeProjects=value=>Array.isArray(value)?value:[],sanitizeHiddenSkills=value=>Array.isArray(value)?value:[],discoverSkills=()=>[],
    resolveSlimConfiguration=resolveSlimConfig,
    onOpenCodeRestarted=()=>{},onStartupStatus=()=>{},assertExecutionReady=()=>{},getNativeRuntime=()=>null,getRuntimeBundle=()=>null,
    probeOpenCodeReadiness=probeOpenCodeRuntime} = deps;
  const assertNative = () => {
    const native=getNativeRuntime(),bundle=getRuntimeBundle();
    if(!native||bundle?.descriptor.generation!==2||env.ENV_SKIP_OPENCODE_START||env.ENV_CONFIGURED_OPENCODE_HOST)throw unavailable();
    return {native,bundle};
  };
  const emitStartupStatus=text=>onStartupStatus(text);
  const getAgentRuntimeApplicationState=()=>({runtimeMode:'managed',appliedLsp:typeof state.appliedAgentRuntimeSettings?.lsp==='boolean'?state.appliedAgentRuntimeSettings.lsp:null});
  const prepareAgentRuntimeConfig = async () => {
    let settings = {};
    try {
      settings = await readSettingsFromDisk();
    } catch {
      settings = {};
    }

    const resolvedWorkingDirectory = resolveManagedWorkingDirectoryFromSettings(
      settings,
      state.openCodeWorkingDirectory,
      sanitizeProjects
    );
    const hiddenSkills = sanitizeHiddenSkills(settings?.hiddenSkills) || [];
    const skills = discoverSkills(resolvedWorkingDirectory);
    const skillPolicy = buildVisibleSkillPolicy({ skills, hiddenSkills });
    const slimConfig = resolveSlimConfiguration(resolvedWorkingDirectory);
    return { workingDirectory: resolvedWorkingDirectory, slimConfig, skillPolicy, packagedOptions: {
      agentOverrides: {},
      skillPolicy,
      excludedAgentNames: slimConfig.enabled ? Array.from(SLIM_REPLACED_AGENT_NAMES) : [],
    } };
  };
  const getPackagedAgentPrompts = async () => {
    const { packagedOptions } = await prepareAgentRuntimeConfig();
    return { prompts: (await syncPackagedAgents({ ...packagedOptions, dryRun: true })).prompts ?? [] };
  };
  const restorePackagedAgentPrompt = async ({ name, expectedHash } = {}) => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)
      || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw Object.assign(new Error('A packaged agent name and its current revision are required'), { status: 400 });
    }
    const { packagedOptions } = await prepareAgentRuntimeConfig();
    const result = await syncPackagedAgents({ ...packagedOptions, restoreAgentNames: [name],
      expectedAgentHashes: { [name]: expectedHash }, restoreOnly: true });
    return { changed: result.changed, backups: result.restored ?? [] };
  };
  const syncManagedAgentRuntimeConfig = async (agentRuntimeSettings = normalizeAgentRuntimeSettings(readAgentRuntimeSettings())) => {
    const { workingDirectory, slimConfig, skillPolicy, packagedOptions } = await prepareAgentRuntimeConfig();
    if (workingDirectory !== state.openCodeWorkingDirectory) {
      state.openCodeWorkingDirectory = workingDirectory;
      syncToHmrState();
    }
    const packagedResult = await syncPackagedAgents(packagedOptions);
    const conflicts = Array.isArray(packagedResult?.conflicts) ? packagedResult.conflicts : [];
    if (conflicts.length > 0) {
      const message = formatPackagedAgentSyncConflicts(conflicts)
        || 'Packaged agent sync conflict';
      console.warn(`[OpenCode] ${message} Continuing with existing runtime agent files.`);
    }
    const overlayResult = await syncRuntimeAgentOverlays({
      workingDirectory: state.openCodeWorkingDirectory,
      skillPolicy,
      agentRuntimeSettings,
    });

    if (packagedResult?.changed) {
      console.log('[OpenCode] Synced packaged agents', {
        written: packagedResult.written ?? [],
        updated: packagedResult.updated ?? [],
        removed: packagedResult.removed ?? [],
      });
    }

    if (overlayResult?.changed) {
      console.log('[OpenCode] Synced runtime agent overlays', {
        written: overlayResult.written ?? [],
        updated: overlayResult.updated ?? [],
        removed: overlayResult.removed ?? [],
        targetConfigDirectory: overlayResult.targetConfigDirectory ?? null,
      });
    }

    return {
      changed: Boolean(packagedResult?.changed || overlayResult?.changed),
      conflicts,
      packaged: packagedResult ?? { changed: false, conflicts: [] },
      overlays: overlayResult ?? { changed: false, targetConfigDirectory: null },
      targetConfigDirectory: overlayResult?.targetConfigDirectory ?? null,
      slimPreset: slimConfig.pluginEnabled && slimConfig.activePreset ? slimConfig.activePreset : null,
      slimConfigDirectory: slimConfig.pluginEnabled ? slimConfig.configDirectory : null,
      runtimeApplied: true,
      requiresReload: true,
    };
  };

  const waitForRuntimeReadiness = async ({ generation, timeoutMs, intervalMs, describe }) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    do {
      try {
        last = await probeOpenCodeReadiness({
          generation,
          baseUrl: buildOpenCodeUrl('/', ''),
          headers: getOpenCodeAuthHeaders(),
          timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())),
        });
      } catch {
        last = { ready: false, reason: 'unreachable' };
      }
      if (last.ready) {
        state.openCodeGeneration = last.generation;
        if (last.version) state.openCodeVersion = last.version;
        return last;
      }
      // An invalid generation declaration never becomes ready.
      if (last.reason === 'generation_invalid') break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (Date.now() < deadline);

    const reason = last?.reason ?? 'timeout';
    const error = new Error(describe(reason));
    error.code = 'opencode_runtime_not_ready';
    error.reason = reason;
    state.isOpenCodeReady = false;
    state.lastOpenCodeError = error.message;
    throw error;
  };

  const waitForOpenCodeReady=async(timeoutMs=20000,intervalMs=400)=>{
    assertNative();if(!state.openCodePort)throw unavailable();
    await waitForRuntimeReadiness({generation:2,timeoutMs,intervalMs,describe:reason=>`Native runtime is not ready: ${reason}`});
    state.isOpenCodeReady=true;state.lastOpenCodeError=null;state.openCodeNotReadySince=0;syncToHmrState();
  };
  const waitForAgentPresence=async(agentName,timeoutMs=15000,intervalMs=300)=>{
    assertNative();await waitForRuntimeReadiness({generation:2,timeoutMs,intervalMs,describe:reason=>`Agent "${agentName}" runtime catalog is not ready: ${reason}`});
  };
  const startOpenCode=async()=>{
    state.isOpenCodeReady=false;assertExecutionReady();const {native,bundle}=assertNative();await bundle.verify();
    if (!SUPPORTED_NATIVE_OPENCODE_VERSIONS.includes(bundle.version)) throw unavailable();
    state.openCodeWorkingDirectory=bundle.descriptor.projectMap[0].targetDirectory;
    const launchSettings=normalizeAgentRuntimeSettings(readAgentRuntimeSettings());
    await syncManagedAgentRuntimeConfig(launchSettings);emitStartupStatus('Starting the verified native runtime…');
    state.openCodeGeneration=2;state.isExternalOpenCode=false;
    const instance=await native.start();state.openCodeProcess=instance;state.openCodeVersion=bundle.version;
    const acceptedConfiguration=native.getConfigurationSnapshot?.()?.locations
      .find(location=>location.directory===state.openCodeWorkingDirectory)?.configuration;
    const acceptedSettings=acceptedConfiguration?{lsp:acceptedConfiguration.lsp!==false}:launchSettings;
    state.openCodeBaseUrl=instance.url;setOpenCodePort(instance.port);setDetectedOpenCodeApiPrefix('');syncToHmrState();
    await waitForOpenCodeReady();state.appliedAgentRuntimeSettings=acceptedSettings;syncToHmrState();return instance;
  };
  let pausedBrowserLeases;
  let browserLeasesPaused=false;
  let restartRecoveryRequired=false;
  const restartOpenCode=async()=>{
    if(state.isShuttingDown)return;if(state.currentRestartPromise)return state.currentRestartPromise;
    assertNative();const restartStartedAt=Date.now();
    // Publish the promise before any injected operation can fail synchronously.
    state.currentRestartPromise=Promise.resolve().then(async()=>{
      state.isRestartingOpenCode=true;state.isOpenCodeReady=false;state.openCodeNotReadySince=Date.now();
      try{
        if(!browserLeasesPaused){pausedBrowserLeases=await pauseManagedBrowserLeases('opencode_restart');browserLeasesPaused=true;}
        if(state.openCodeProcess){if(state.openCodeProcess.hasExited())await state.openCodeProcess.killForRecovery();else await state.openCodeProcess.close();}
        state.openCodeProcess=null;state.openCodePort=null;syncToHmrState();
        await startOpenCode();if(state.expressApp){setupProxy(state.expressApp);ensureOpenCodeApiPrefix();}
        await onOpenCodeRestarted({restartStartedAt});
        await resumeManagedBrowserLeases(pausedBrowserLeases);
        browserLeasesPaused=false;pausedBrowserLeases=undefined;restartRecoveryRequired=false;
      }catch(error){restartRecoveryRequired=true;state.lastOpenCodeError=error.message;state.isOpenCodeReady=false;throw error;}
      finally{state.isRestartingOpenCode=false;state.currentRestartPromise=null;syncToHmrState();}
    });return state.currentRestartPromise;
  };
  const bootstrapOpenCodeAtStartup=async()=>{
    const {native,bundle}=assertNative();syncFromHmrState();state.isOpenCodeReady=false;
    // A process inherited from an older module has no authority in this owner.
    if(state.openCodeProcess&&!state.openCodeProcess.hasExited()){
      if(state.openCodeGeneration!==2||state.openCodeVersion!==bundle.version||native.isReady?.()!==true){
        const error=unavailable('native_runtime_owner_mismatch');state.lastOpenCodeError=error.message;syncToHmrState();throw error;
      }
      await waitForOpenCodeReady();return;
    }
    try{return await startOpenCode();}catch(error){state.isOpenCodeReady=false;state.lastOpenCodeError=error.message;syncToHmrState();throw error;}
  };
  let failures=0;
  const triggerHealthCheck=async()=>{
    if(state.isShuttingDown||state.isRestartingOpenCode)return;
    if(restartRecoveryRequired){await restartOpenCode();return;}
    if(!state.openCodeProcess)return;
    if(state.openCodeProcess.hasExited()){await restartOpenCode();return;}
    const result=await probeOpenCodeReadiness({generation:2,baseUrl:buildOpenCodeUrl('/',''),headers:getOpenCodeAuthHeaders(),signal:AbortSignal.timeout(5000)}).catch(()=>({ready:false}));
    state.openCodeProbe={checkedAt:Date.now(),succeeded:result.ready===true};
    if(result.ready){failures=0;return;}if(getActiveSessionCount()>0)return;
    const configured=Number(process.env.DEVRYAN_HEALTH_RESTART_FAILURES),limit=Number.isSafeInteger(configured)&&configured>=1&&configured<=10?configured:3;
    if(++failures>=limit){failures=0;await restartOpenCode();}
  };
  const startHealthMonitoring=interval=>{clearInterval(state.healthCheckInterval);state.healthCheckInterval=setInterval(()=>{void triggerHealthCheck().catch(error=>{state.lastOpenCodeError=error.message;});},interval);};
  const applyOpenCodeConfigChanges = async ({ scopes = [], changes = [] } = {}) => {
    const options = [...changes]
      .reverse()
      .map((entry) => entry?.metadata)
      .find((metadata) => metadata && typeof metadata === 'object') || {};
    const { agentName, expectedAgentModelRef, expectedAgentVariant } = options;
    const agentReadyTimeoutMs = Number.isFinite(options.agentReadyTimeoutMs) && options.agentReadyTimeoutMs > 0
      ? Math.trunc(options.agentReadyTimeoutMs)
      : 15000;
    const agentReadyIntervalMs = Number.isFinite(options.agentReadyIntervalMs) && options.agentReadyIntervalMs > 0
      ? Math.trunc(options.agentReadyIntervalMs)
      : 300;

    console.log(`Applying saved OpenCode configuration scopes: ${scopes.join(', ') || 'runtime'}`);
    await restartOpenCode();

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      if (agentName) {
        await waitForAgentPresence(agentName, agentReadyTimeoutMs, agentReadyIntervalMs, {
          expectedAgentModelRef,
          ...(Object.prototype.hasOwnProperty.call(options, 'expectedAgentVariant') ? { expectedAgentVariant } : {}),
        });
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
      return {
        runtimeApplied: true,
        requiresReload: false,
      };
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error('Failed to apply saved OpenCode configuration:', error.message);
      throw error;
    }
  };

  return {startOpenCode,restartOpenCode,waitForOpenCodeReady,waitForAgentPresence,applyOpenCodeConfigChanges,
    syncManagedAgentRuntimeConfig,getAgentRuntimeApplicationState,getPackagedAgentPrompts,restorePackagedAgentPrompt,
    bootstrapOpenCodeAtStartup,startHealthMonitoring,triggerHealthCheck};
};
