import { printTunnelWarning } from '../cloudflare-tunnel.js';
import { createTunnelService } from '../tunnels/index.js';
import { createTunnelRoutesRuntime } from '../tunnels/routes.js';

export const createTunnelWiringRuntime = (dependencies) => {
  const {
    crypto,
    URL,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteOriginPort,
    isValidManagedRemoteOriginPort,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelPreset,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TunnelServiceError,
    getActiveTunnelController,
    setActiveTunnelController,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
    getRuntimeReady,
  } = dependencies;

  const initialize = (app, initialPort, runtimeOptions = {}) => {
    let activePort = initialPort;

    const tunnelService = createTunnelService({
      registry: tunnelProviderRegistry,
      getController: getActiveTunnelController,
      setController: setActiveTunnelController,
      getActivePort: () => activePort,
      onQuickTunnelWarning: () => {
        printTunnelWarning();
      },
      onControllerTerminated: () => {
        tunnelAuthController.clearActiveTunnel();
      },
      runtimeInstanceId: runtimeOptions.runtimeInstanceId,
      fetchImpl: runtimeOptions.fetchImpl,
    });

    const tunnelRoutesRuntime = createTunnelRoutesRuntime({
      crypto,
      URL,
      tunnelService,
      tunnelProviderRegistry,
      tunnelAuthController,
      readSettingsFromDiskMigrated,
      readManagedRemoteTunnelConfigFromDisk,
      normalizeTunnelProvider,
      normalizeTunnelMode,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname,
      normalizeManagedRemoteOriginPort,
      isValidManagedRemoteOriginPort,
      normalizeTunnelBootstrapTtlMs,
      normalizeTunnelSessionTtlMs,
      isSupportedTunnelMode,
      upsertManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelPreset,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      TUNNEL_PROVIDER_CLOUDFLARE,
      TunnelServiceError,
      getActivePort: () => activePort,
      getRuntimeManagedRemoteTunnelHostname,
      setRuntimeManagedRemoteTunnelHostname,
      getRuntimeManagedRemoteTunnelToken,
      setRuntimeManagedRemoteTunnelToken,
      getActiveTunnelController,
      setActiveTunnelController,
      getRuntimeReady,
    });

    tunnelRoutesRuntime.registerRoutes(app);

    return {
      tunnelService,
      startTunnelWithNormalizedRequest: (...args) => tunnelRoutesRuntime.startTunnelWithNormalizedRequest(...args),
      getActivePort: () => activePort,
      setActivePort: (value) => {
        activePort = value;
      },
    };
  };

  return {
    initialize,
  };
};
