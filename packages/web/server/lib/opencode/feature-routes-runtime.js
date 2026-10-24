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
      devryanDataDir,
      projectIconStore,
      devryanUserConfigRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      markConfigChange,
      configApplyCoordinator,
      canForceConfigRestart,
      retireLegacyCursorPlugin,
      abortActiveSessionsForConfigRestart,
      auditForceConfigRestart,
      getOpenCodeResolutionSnapshot,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      sanitizeHiddenSkills,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      openCodeClient,
      getOpenCodeAuthHeaders,
      cursorSdkRuntime,
      standardSessionTitleRuntime,
      getOpenCodePort,
      getOpenCodeWorkingDirectory,
      setOpenCodeWorkingDirectory,
      restartOpenCode,
      waitForOpenCodeReady,
      isExternalOpenCode,
      getPackagedAgentPrompts,
      restorePackagedAgentPrompt,
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      getDevRyanEventClients,
      writeSseEvent,
      emitSyntheticOpenCodeEvent,
      resolveZenModel,
      resolveZenModelNonBlocking,
      xaiToolCatalogRuntime,
      recordCommitTiming,
      generateHelperText,
      resolveHelperSelection,
      cursorTextRuntime,
      resolveManagedProject,
      ownsSession,
      resolveOwnedSessionPlanContext,
      recordPlanDiagnostic,
      readCanonicalPlanIdentity,
      getLoginShellEnvSnapshot,
    } = routeDependencies;

    const {
      getProviderSources,
      listProviderConfigFiles,
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
      retireLegacyCursorPlugin,
    });

    // Host process inspection (bottom-dock Processes tab, session-delete auto-stop).
    const processesRuntime = createProcessesRuntime({ dataDir: devryanDataDir });

    registerOpenCodeRoutes(app, {
      openCodeClient,
      recordDiagnostic: routeDependencies.recordDiagnostic,
      getNativeRuntimeOwner: routeDependencies.getNativeRuntimeOwner,
      getClaudeEnrollmentOwner: () => routeDependencies.getNativeRuntimeOwner?.()?.getClaudeEnrollmentOwner?.(),
      isProviderAdministrator: routeDependencies.isProviderAdministrator,
      crypto,
      clientReloadDelayMs,
      getOpenCodeResolutionSnapshot,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      validateDirectoryPath,
      ensureNativeDirectory: routeDependencies.ensureNativeDirectory,
      resolveProjectDirectory,
      getProviderSources,
      listProviderConfigFiles,
      getProviderEnvironmentSnapshot: getLoginShellEnvSnapshot,
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
      isStartupReadinessPending: routeDependencies.isStartupReadinessPending,
      resolveZenModel,
      resolveZenModelNonBlocking,
      xaiToolCatalogRuntime,
    });

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      devryanDataDir,
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
      getDevRyanEventClients,
      writeSseEvent,
      resolveManagedProject,
    });

    const pluginReadModel = createPluginReadModel({ fs, path, os });
    registerReadonlyPluginRoutes(app, {
      resolveOptionalProjectDirectory,
      listPlugins: pluginReadModel.listPlugins,
    });

    const {
      getAgentSources,
      getAgentConfig,
      listAgentModelOverrides,
      listStaleAgentModelOverrides,
      listShadowedAgentModelOverrides,
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
      readAgentModelCatalog: directory => openCodeClient.catalog.providers({ directory }, { timeoutMs: 5_000 }),
      validateCursorModelSelection: input => cursorSdkRuntime?.validateModelSelection?.(input) ?? null,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      markConfigChange,
      clientReloadDelayMs,
      getAgentSources,
      getAgentConfig,
      listAgentModelOverrides,
      listStaleAgentModelOverrides,
      listShadowedAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
      writeAgentBackupModel,
      deleteAgentBackupModel,
      getPackagedAgentPrompts,
      restorePackagedAgentPrompt,
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
      openCodeClient,
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
      devryanDataDir,
      isProviderAdministrator: routeDependencies.isProviderAdministrator,
      getNativeRuntimeOwner: routeDependencies.getNativeRuntimeOwner,
      openCodeClient,
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
      openCodeClient,
      generateHelperText,
      resolveHelperSelection,
      cursorRuntime: cursorTextRuntime,
      recordCommitTiming,
      prepareNativeDirectory: routeDependencies.ensureNativeDirectory,
      // Native Zen helper sessions, plus PR description tier 2 (session model).
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    });
    registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      devryanDataDir,
    });
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      devryanDataDir,
    });
    registerSessionPlanRoutes(app, {
      dataDirectory: devryanDataDir,
      fsPromises,
      path,
      ownsSession,
      resolveOwnedSessionPlanContext,
      publishEvent: emitSyntheticOpenCodeEvent,
      recordDiagnostic: recordPlanDiagnostic,
      readCanonicalPlanIdentity,
    });
    const imageAssetsRuntime = createImageAssetsRuntime({
      openCodeClient,
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
      devryanUserConfigRoot,
      authorizeImageAssetGrant: imageAssetsRuntime.authorizeAssetGrant,
    });
  };

  return {
    registerRoutes,
    close: () => {},
  };
};
