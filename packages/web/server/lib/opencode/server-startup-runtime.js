export const createServerStartupRuntime = (dependencies) => {
  const {
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
    bootstrapOpenCodeAtStartup = async () => {},
    getRuntimeReady = () => true,
  } = dependencies;

  const resolveBindHost = (host) =>
    host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');

  const startListeningAndMaybeTunnel = async ({
    port,
    bindHost,
    startupTunnelRequest,
    onTunnelReady,
  }) => {
    let activePort = port;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('error', onError);
        reject(error);
      };
      server.once('error', onError);
      const onListening = async () => {
        server.off('error', onError);
        const addressInfo = server.address();
        activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

        try {
          process.send?.({ type: 'openchamber:ready', port: activePort });
        } catch {
          // ignore
        }

        const displayHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')
          ? 'localhost'
          : (bindHost.includes(':') ? `[${bindHost}]` : bindHost);
        console.log(`OpenChamber server listening on ${bindHost}:${activePort}`);
        console.log(`Health check: http://${displayHost}:${activePort}/health`);
        console.log(`Web interface: http://${displayHost}:${activePort}`);

        try {
          await bootstrapOpenCodeAtStartup();
        } catch (error) {
          reject(error);
          return;
        }

        if (startupTunnelRequest) {
          const startupModeLabel = startupTunnelRequest.mode === TUNNEL_MODE_QUICK
            ? 'Quick Tunnel'
            : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_LOCAL
              ? 'Managed Local Tunnel'
              : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_REMOTE ? 'Managed Remote Tunnel' : 'Tunnel'));
          console.log(`\nInitializing ${startupModeLabel} for provider '${startupTunnelRequest.provider}'...`);
          try {
            if (!getRuntimeReady()) {
              throw Object.assign(new Error('DevRyan runtime is not ready; tunnel startup is paused'), {
                code: 'runtime_not_ready',
              });
            }
            const { publicUrl, mode } = await startTunnelWithNormalizedRequest({
              provider: startupTunnelRequest.provider,
              mode: startupTunnelRequest.mode,
              intent: startupTunnelRequest.intent,
              hostname: startupTunnelRequest.hostname,
              token: startupTunnelRequest.token,
              configPath: startupTunnelRequest.configPath,
              originPort: startupTunnelRequest.originPort,
              selectedPresetId: '',
              selectedPresetName: '',
            });
            if (publicUrl) {
              tunnelAuthController.setActiveTunnel({
                tunnelId: crypto.randomUUID(),
                publicUrl,
                mode,
              });
              let connectUrl = null;
              if (mode !== TUNNEL_MODE_MANAGED_REMOTE) {
                const settings = await readSettingsFromDiskMigrated();
                const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
                  ? null
                  : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
                const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
                connectUrl = `${publicUrl.replace(/\/$/, '')}/tunnel/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
              }
              if (onTunnelReady) {
                onTunnelReady(publicUrl, connectUrl);
              } else if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
                console.log(`\n🌐 Tunnel URL: ${publicUrl}`);
                console.log('🔐 Sign in with your DevRyan account\n');
              } else {
                console.log(`\n🌐 Tunnel URL: ${connectUrl}`);
                console.log('🔑 One-time connect link (expires after first use)\n');
              }
            } else if (onTunnelReady) {
              onTunnelReady(publicUrl, null);
            }
          } catch (error) {
            console.error(`Failed to start tunnel: ${error.message}`);
            console.log('Continuing without tunnel...');
          }
        }

        resolve();
      };

      server.listen(port, bindHost, onListening);
    });

    return { activePort };
  };

  const attachProcessHandlers = ({ attachSignals }) => {
    if (attachSignals && !getSignalsAttached()) {
      const handleSignal = async () => {
        await gracefulShutdown();
      };
      process.on('SIGTERM', handleSignal);
      process.on('SIGINT', handleSignal);
      process.on('SIGQUIT', handleSignal);
      setSignalsAttached(true);
      syncToHmrState();
    }

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      if (process.env.OPENCHAMBER_DEV_MODE === 'true') {
        // Previously this called process.exit(1) directly, which orphaned the
        // managed `opencode serve` child on every dev-mode crash/HMR restart (the
        // child is not detached and has no die-with-parent guarantee on macOS, so
        // these orphans accumulate across runs and leak hundreds of MB each).
        // Reap it via gracefulShutdown first, with a hard cap so a hung shutdown
        // still exits the dev process promptly.
        const forceExit = setTimeout(() => process.exit(1), 4000);
        forceExit.unref?.();
        void gracefulShutdown({ exitProcess: true }).catch(() => process.exit(1));
        return;
      }
      gracefulShutdown();
    });
  };

  return {
    resolveBindHost,
    startListeningAndMaybeTunnel,
    attachProcessHandlers,
  };
};
