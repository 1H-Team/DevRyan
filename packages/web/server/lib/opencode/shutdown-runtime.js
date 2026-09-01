export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    getBotsRuntime,
    getManagedOrchestrationRuntime,
    getBrowserLeaseRuntime,
    getCursorSdkRuntime,
    getSessionTitleRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    killProcessOnPort,
    waitForPortRelease,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
    getHarnessRuntime,
  } = dependencies;

  const gracefulShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();
    const harnessRuntime = typeof getHarnessRuntime === 'function' ? getHarnessRuntime() : null;
    harnessRuntime?.beginDrain?.();

    openCodeWatcherRuntime.stop();
    sessionRuntime.dispose();
    scheduledTasksRuntime?.stop?.();

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
      } finally {
        setMessageStreamRuntime(null);
      }
    }

    if (harnessRuntime && typeof harnessRuntime.drain === 'function') {
      let harnessDrainTimeout = null;
      try {
        await Promise.race([
          harnessRuntime.drain(),
          new Promise((resolve) => {
            harnessDrainTimeout = setTimeout(() => {
              console.warn('Harness drain timeout reached, continuing shutdown');
              resolve();
            }, 5000);
          }),
        ]);
      } catch (error) {
        console.warn('Error draining harness runtime:', error);
      } finally {
        if (harnessDrainTimeout) clearTimeout(harnessDrainTimeout);
      }
    }

    const botsRuntime = typeof getBotsRuntime === 'function' ? getBotsRuntime() : null;
    if (botsRuntime && typeof botsRuntime.shutdown === 'function') {
      try {
        await botsRuntime.shutdown();
      } catch (error) {
        console.warn('Error stopping Production Bots runtime:', error);
      }
    }

    const browserLeaseRuntime = typeof getBrowserLeaseRuntime === 'function'
      ? getBrowserLeaseRuntime()
      : null;
    if (browserLeaseRuntime && typeof browserLeaseRuntime.closeAll === 'function') {
      try {
        await browserLeaseRuntime.closeAll('shutdown');
      } catch (error) {
        console.warn('Error stopping agent browser leases:', error);
      }
    }

    const managedOrchestrationRuntime = typeof getManagedOrchestrationRuntime === 'function'
      ? getManagedOrchestrationRuntime()
      : null;
    if (managedOrchestrationRuntime && typeof managedOrchestrationRuntime.shutdown === 'function') {
      try {
        await managedOrchestrationRuntime.shutdown();
      } catch (error) {
        console.warn('Error stopping managed orchestration runtime:', error);
      }
    }

    const cursorSdkRuntime = typeof getCursorSdkRuntime === 'function' ? getCursorSdkRuntime() : null;
    if (cursorSdkRuntime && typeof cursorSdkRuntime.dispose === 'function') {
      try {
        await cursorSdkRuntime.dispose();
      } catch {
      }
    }

    const sessionTitleRuntime = typeof getSessionTitleRuntime === 'function'
      ? getSessionTitleRuntime()
      : null;
    if (sessionTitleRuntime && typeof sessionTitleRuntime.dispose === 'function') {
      try {
        await sessionTitleRuntime.dispose();
      } catch (error) {
        console.warn('Error stopping session title runtime:', error);
      }
    }

    if (!shouldSkipOpenCodeStop()) {
      const portToKill = getOpenCodePort();
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        let openCodeCloseTimeout = null;
        try {
          await Promise.race([
            openCodeProcess.close(),
            new Promise((resolve) => {
              openCodeCloseTimeout = setTimeout(() => {
                console.warn('OpenCode close timeout reached, continuing shutdown');
                resolve();
              }, Math.min(shutdownTimeoutMs, 4000));
            }),
          ]);
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        } finally {
          if (openCodeCloseTimeout) {
            clearTimeout(openCodeCloseTimeout);
          }
        }
        setOpenCodeProcess(null);
      }

      killProcessOnPort(portToKill);
      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
          }),
          new Promise((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const activeTunnelController = getActiveTunnelController();
    if (activeTunnelController) {
      console.log('Stopping active tunnel...');
      activeTunnelController.stop();
      setActiveTunnelController(null);
      tunnelAuthController.clearActiveTunnel();
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) {
      process.exit(0);
    }
  };

  return {
    gracefulShutdown,
  };
};
