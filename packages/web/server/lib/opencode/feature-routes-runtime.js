import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { createProcessesRuntime } from '../processes/runtime.js';
import { registerProcessesRoutes } from '../processes/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerSessionPlanRoutes } from '../plans/routes.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerOpenCodeRoutes } from './routes.js';
import { createPluginReadModel, registerReadonlyPluginRoutes } from './plugins-readonly.js';
import { createSlimSetupRuntime, registerSlimSetupRoutes } from './slim-install.js';
import { registerConfigApplyRoutes } from './config-apply-runtime.js';
import { createImageAssetsRuntime } from '../image-assets/runtime.js';

export const createFeatureRoutesRuntime = (dependencies) => {
  const {
    clientReloadDelayMs,
  } = dependencies;

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

  const registerRoutes = async (app, routeDependencies) => {
    const {
      crypto,
      fs,
      os,
      path,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      createFsSearchRuntime,
      openchamberDataDir,
      projectIconStore,
      openchamberUserConfigRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      markConfigChange,
      configApplyCoordinator,
      canForceConfigRestart,
      abortActiveSessionsForConfigRestart,
      auditForceConfigRestart,
      getOpenCodeResolutionSnapshot,
      checkForOpenCodeUpdates,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      sanitizeHiddenSkills,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      cursorSdkRuntime,
      standardSessionTitleRuntime,
      getOpenCodePort,
      getOpenCodeWorkingDirectory,
      setOpenCodeWorkingDirectory,
      restartOpenCode,
      waitForOpenCodeReady,
      isExternalOpenCode,
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      getOpenChamberEventClients,
      writeSseEvent,
      emitSyntheticOpenCodeEvent,
      resolveZenModel,
      resolveZenModelNonBlocking,
      fetchFreeZenModels,
      getCachedZenModels,
      xaiToolCatalogRuntime,
      recordCommitTiming,
      resolveManagedProject,
      ownsSession,
      resolveOwnedSessionPlanContext,
    } = routeDependencies;

    const {
      getProviderSources,
      removeAntigravityProviderConfig,
      removeProviderConfig,
      ensureAnthropicOAuthProviderConfig,
    } = await import('./index.js');

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
    });

    registerConfigApplyRoutes(app, {
      coordinator: configApplyCoordinator,
      markConfigChange,
      canForceRestart: canForceConfigRestart,
      abortActiveSessions: abortActiveSessionsForConfigRestart,
      auditForceRestart: auditForceConfigRestart,
    });

    // Host process inspection (bottom-dock Processes tab, session-delete auto-stop).
    const processesRuntime = createProcessesRuntime({ dataDir: openchamberDataDir });

    registerOpenCodeRoutes(app, {
      crypto,
      clientReloadDelayMs,
      getOpenCodeResolutionSnapshot,
      checkForOpenCodeUpdates,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      validateDirectoryPath,
      resolveProjectDirectory,
      getProviderSources,
      removeAntigravityProviderConfig,
      removeProviderConfig,
      ensureAnthropicOAuthProviderConfig,
      markConfigChange,
      buildAugmentedPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodeWorkingDirectory,
      setOpenCodeWorkingDirectory,
      restartOpenCode,
      waitForOpenCodeReady,
      isExternalOpenCode,
      cursorSdkRuntime,
      processesRuntime,
      standardSessionTitleRuntime,
      emitSyntheticOpenCodeEvent,
      resolveZenModel,
      resolveZenModelNonBlocking,
      xaiToolCatalogRuntime,
    });

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir,
      projectIconStore,
      sanitizeProjects,
      readSettingsFromDiskMigrated,
      persistSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
      resolveManagedProject,
    });

    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      getOpenChamberEventClients,
      writeSseEvent,
      resolveManagedProject,
    });

    const pluginReadModel = createPluginReadModel({ fs, path, os });
    registerReadonlyPluginRoutes(app, {
      resolveOptionalProjectDirectory,
      listPlugins: pluginReadModel.listPlugins,
    });
    registerSlimSetupRoutes(app, {
      slimSetupRuntime: createSlimSetupRuntime({
        fs,
        path,
        os,
        spawn,
        env: process.env,
      }),
      markConfigChange,
    });

    const {
      getAgentSources,
      getAgentConfig,
      listAgentModelOverrides,
      listStaleAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
      writeAgentBackupModel,
      deleteAgentBackupModel,
      listConfigAgents,
      getCommandSources,
      createCommand,
      updateCommand,
      deleteCommand,
      listMcpConfigs,
      getMcpConfig,
      createMcpConfig,
      updateMcpConfig,
      deleteMcpConfig,
      recoverMcpConfigs,
    } = await import('./index.js');

    registerConfigEntityRoutes(app, {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      markConfigChange,
      clientReloadDelayMs,
      getAgentSources,
      getAgentConfig,
      listAgentModelOverrides,
      listStaleAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
      writeAgentBackupModel,
      deleteAgentBackupModel,
      listConfigAgents,
      getCommandSources,
      createCommand,
      updateCommand,
      deleteCommand,
      listMcpConfigs,
      getMcpConfig,
      createMcpConfig,
      updateMcpConfig,
      deleteMcpConfig,
      recoverMcpConfigs,
    });

    const {
      getSkillSources,
      discoverSkills,
      createSkill,
      updateSkill,
      deleteSkill,
      readSkillSupportingFile,
      writeSkillSupportingFile,
      deleteSkillSupportingFile,
      SKILL_SCOPE,
      SKILL_DIR,
    } = await import('./index.js');

    const {
      getCuratedSkillsSources,
      getCacheKey,
      getCachedScan,
      setCachedScan,
      parseSkillRepoSource,
      scanSkillsRepository,
      installSkillsFromRepository,
      scanClawdHubPage,
      installSkillsFromClawdHub,
      isClawdHubSource,
    } = await import('../skills-catalog/index.js');
    const { getProfiles, getProfile } = await import('../git/index.js');

    registerSkillRoutes(app, {
      fs,
      path,
      os,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      readSettingsFromDisk,
      persistSettings,
      sanitizeSkillCatalogs,
      sanitizeHiddenSkills,
      isUnsafeSkillRelativePath,
      markConfigChange,
      isExternalOpenCode,
      clientReloadDelayMs,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
      getSkillSources,
      discoverSkills,
      createSkill,
      updateSkill,
      deleteSkill,
      readSkillSupportingFile,
      writeSkillSupportingFile,
      deleteSkillSupportingFile,
      SKILL_SCOPE,
      SKILL_DIR,
      getCuratedSkillsSources,
      getCacheKey,
      getCachedScan,
      setCachedScan,
      parseSkillRepoSource,
      scanSkillsRepository,
      installSkillsFromRepository,
      scanClawdHubPage,
      installSkillsFromClawdHub,
      isClawdHubSource,
      getProfiles,
      getProfile,
    });

    registerQuotaRoutes(app, {
      getQuotaProviders,
      resolveProjectDirectory,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      isExternalOpenCode,
      buildAugmentedPath,
      ownsSession,
    });
    registerGitHubRoutes(app);
    registerProcessesRoutes(app, { runtime: processesRuntime });
    registerGitRoutes(app, {
      resolveZenModel,
      resolveCommitZenModel: resolveZenModelNonBlocking,
      fetchFreeZenModels,
      // Last known free-model catalog so a catalog outage degrades to stale
      // models (then the session model) instead of failing with no attempt.
      getCachedFreeZenModels: getCachedZenModels,
      recordCommitTiming,
      // PR description tier 2 (session model through a hidden helper session).
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    });
    registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerSessionPlanRoutes(app, {
      dataDirectory: openchamberDataDir,
      fsPromises,
      path,
      ownsSession,
      resolveOwnedSessionPlanContext,
    });
    const imageAssetsRuntime = createImageAssetsRuntime({
      fsPromises,
      path,
      os,
      crypto,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      ownsSession,
    });
    imageAssetsRuntime.registerRoutes(app);
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn,
      crypto,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      buildAugmentedPath,
      resolveGitBinaryForSpawn,
      openchamberUserConfigRoot,
      authorizeImageAssetGrant: imageAssetsRuntime.authorizeAssetGrant,
    });
  };

  return {
    registerRoutes,
  };
};
