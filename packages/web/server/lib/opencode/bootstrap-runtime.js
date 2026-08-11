export const createBootstrapRuntime = (dependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    express,
  } = dependencies;

  const setupBaseRoutes = (app, options) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      runtimeInstanceId,
      gracefulShutdown,
      getHealthSnapshot,
      verboseRequestLogs,
      uiPassword,
      tunnelAuthController,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      getRuntimeReady,
      resolveZenModel,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      updateUiVisibility,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      multiUserRuntime,
      registerPrivateCapabilityRoutes,
    } = options;

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs });
    if (typeof registerPrivateCapabilityRoutes === 'function') {
      registerPrivateCapabilityRoutes(app);
    }

    const legacyUiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDiskMigrated,
    });
    multiUserRuntime?.attachLoopbackPasskeyController?.(legacyUiAuthController);
    const uiAuthController = multiUserRuntime?.enabled
      ? multiUserRuntime.authController
      : multiUserRuntime?.wrapLegacyAuthController?.(legacyUiAuthController) ?? legacyUiAuthController;

    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      runtimeInstanceId,
      gracefulShutdown,
      getHealthSnapshot,
      uiAuthController,
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    registerAuthAndAccessRoutes(app, {
      tunnelAuthController,
      uiAuthController,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      getRuntimeReady,
    });

    registerTtsRoutes(app, { resolveZenModel, sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      multiUserRuntime,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      updateUiVisibility,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      getSessionAttentionState: sessionRuntime.getSessionAttentionState,
      markSessionViewed: sessionRuntime.markSessionViewed,
      markSessionUnviewed: sessionRuntime.markSessionUnviewed,
      markUserMessageSent: sessionRuntime.markUserMessageSent,
      setPushInitialized,
      setAutoAcceptSession,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
