import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerOpenCodeRoutes } from './routes.js';
import { createPluginReadModel, registerReadonlyPluginRoutes } from './plugins-readonly.js';
import { createSlimSetupRuntime, registerSlimSetupRoutes } from './slim-install.js';

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
      openchamberUserConfigRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
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
      getOpenCodeAuthHeaders,
      cursorSdkRuntime,
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
    } = routeDependencies;

    const {
      getProviderSources,
      removeProviderConfig,
      ensureAnthropicOAuthProviderConfig,
    } = await import('./index.js');

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
    });

    registerOpenCodeRoutes(app, {
      crypto,
      clientReloadDelayMs,
      getOpenCodeResolutionSnapshot,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      validateDirectoryPath,
      resolveProjectDirectory,
      getProviderSources,
      removeProviderConfig,
      ensureAnthropicOAuthProviderConfig,
      refreshOpenCodeAfterConfigChange,
      buildAugmentedPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodeWorkingDirectory,
      setOpenCodeWorkingDirectory,
      restartOpenCode,
      waitForOpenCodeReady,
      isExternalOpenCode,
      cursorSdkRuntime,
      emitSyntheticOpenCodeEvent,
      resolveZenModel,
    });

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir,
      sanitizeProjects,
      readSettingsFromDiskMigrated,
      persistSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });

    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      getOpenChamberEventClients,
      writeSseEvent,
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
      refreshOpenCodeAfterConfigChange,
    });

    const {
      getAgentSources,
      getAgentConfig,
      listAgentModelOverrides,
      listStaleAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
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
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      getAgentSources,
      getAgentConfig,
      listAgentModelOverrides,
      listStaleAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
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
      refreshOpenCodeAfterConfigChange,
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
    });
    registerGitHubRoutes(app);
    registerGitRoutes(app, { resolveZenModel });
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
    });
  };

  return {
    registerRoutes,
  };
};
