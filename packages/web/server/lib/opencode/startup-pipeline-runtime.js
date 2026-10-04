import { resolveGen2OpenCodeClient } from './opencode-client-seam.js';
import { createOpenCodeV2SseHandler } from './v2/sse-routes.js';
import { sendOpenCodeFacadeError } from './v2/facade-routes.js';

export const createStartupPipelineRuntime = (dependencies) => {
  const {
    createTerminalRuntime,
    createMessageStreamWsRuntime,
    createServerStartupRuntime,
  } = dependencies;

  const run = async (options) => {
    const {
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      globalEventHub,
      openCodeClient,
      messageStreamWsClients,
      registerRetentionConnection,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
      terminalHeartbeatIntervalMs,
      terminalRebindWindowMs,
      terminalMaxRebindsPerWindow,
      setupProxy,
      scheduleOpenCodeApiDetection,
      bootstrapOpenCodeAtStartup,
      staticRoutesRuntime,
      process,
      crypto,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      host,
      port,
      startupTunnelRequest,
      onTunnelReady,
      tunnelRuntimeContext,
      attachSignals,
      multiUserRuntime,
      onTerminalSessionClosed,
    } = options;

    const terminalRuntime = createTerminalRuntime({
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: terminalHeartbeatIntervalMs,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: terminalRebindWindowMs,
      TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: terminalMaxRebindsPerWindow,
      multiUserRuntime,
      onTerminalSessionClosed,
    });

    const messageStreamRuntime = createMessageStreamWsRuntime({
      server,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      globalEventHub,
      wsClients: messageStreamWsClients,
      registerRetentionConnection,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
      eventFilter: multiUserRuntime?.filterEventForPrincipal,
    });

    if (globalEventHub) {
      const v2SseHandler = createOpenCodeV2SseHandler({
        globalMessageStreamHub: globalEventHub,
        eventFilter: multiUserRuntime?.filterEventForPrincipal,
        registerConnection: multiUserRuntime?.registerConnection,
      });
      app.get('/api/global/event', async (req, res) => {
        try {
          resolveGen2OpenCodeClient(openCodeClient);
          await v2SseHandler(req, res);
        } catch (error) { sendOpenCodeFacadeError(res, error); }
      });
    }

    setupProxy(app);
    scheduleOpenCodeApiDetection();

    staticRoutesRuntime.registerStaticRoutes(app);

    const serverStartupRuntime = createServerStartupRuntime({
      process,
      crypto,
      server,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      bootstrapOpenCodeAtStartup,
      getRuntimeReady: options.getRuntimeReady,
    });

    const bindHost = serverStartupRuntime.resolveBindHost(host);
    const startupResult = await serverStartupRuntime.startListeningAndMaybeTunnel({
      port,
      bindHost,
      startupTunnelRequest,
      onTunnelReady,
    });
    tunnelRuntimeContext.setActivePort(startupResult.activePort);

    serverStartupRuntime.attachProcessHandlers({ attachSignals });

    return {
      terminalRuntime,
      messageStreamRuntime,
    };
  };

  return {
    run,
  };
};
