import {
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  normalizeTunnelStartRequest,
  validateTunnelStartRequest,
} from './types.js';

export function createTunnelService({
  registry,
  getController,
  setController,
  getActivePort,
  onQuickTunnelWarning,
  onControllerTerminated,
  runtimeInstanceId,
  fetchImpl,
}) {
  if (!registry) {
    throw new Error('Tunnel service requires a provider registry');
  }

  const resolveActiveMode = () => {
    const controller = getController();
    if (!controller || typeof controller.mode !== 'string') {
      return null;
    }
    return controller.mode;
  };

  const resolveActiveProvider = () => {
    const controller = getController();
    if (!controller || typeof controller.provider !== 'string') {
      return null;
    }
    return controller.provider;
  };

  let stopPromise = null;

  const observeControllerTermination = (controller) => {
    if (typeof controller?.onTerminated !== 'function') {
      return;
    }
    controller.onTerminated(() => {
      if (getController() !== controller) {
        return;
      }
      setController(null);
      try {
        onControllerTerminated?.(controller);
      } catch {
        // Controller cleanup must remain authoritative even if an observer fails.
      }
    });
  };

  const stop = () => {
    if (stopPromise) {
      return stopPromise;
    }

    const controller = getController();
    if (!controller) {
      return Promise.resolve(false);
    }

    stopPromise = (async () => {
      const providerId = typeof controller.provider === 'string' ? controller.provider : '';
      const provider = providerId ? registry.get(providerId) : null;
      if (provider?.stop) {
        await provider.stop(controller);
      } else {
        await controller.stop?.();
      }
      if (getController() === controller) {
        setController(null);
      }
      return true;
    })().finally(() => {
      stopPromise = null;
    });

    return stopPromise;
  };

  const checkAvailability = async (providerId) => {
    const provider = registry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }
    const result = await provider.checkAvailability();
    return result;
  };

  // Mutex to prevent concurrent tunnel starts from orphaning child processes.
  let startLock = Promise.resolve();

  const start = async (rawRequest, options = {}) => {
    let releaseLock;
    const lockPromise = new Promise((resolve) => { releaseLock = resolve; });
    const previousLock = startLock;
    startLock = lockPromise;

    await previousLock;

    try {
      if (stopPromise) {
        await stopPromise;
      }

      const request = normalizeTunnelStartRequest(rawRequest);
      const provider = registry.get(request.provider);

      if (!provider) {
        throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
      }

      validateTunnelStartRequest(request, provider.capabilities);

      const activeController = getController();
      let publicUrl = activeController?.getPublicUrl?.() ?? null;
      const activeMode = resolveActiveMode();
      const activeProvider = resolveActiveProvider();
      const activePort = Number.isFinite(getActivePort?.()) ? getActivePort() : null;
      const originUrl = activePort !== null ? `http://127.0.0.1:${activePort}` : undefined;
      const context = {
        activePort,
        originUrl,
        runtimeInstanceId,
        fetchImpl,
        ...options,
      };

      const controllerCompatible = Boolean(publicUrl)
        && activeMode === request.mode
        && activeProvider === request.provider
        && (typeof provider.isControllerCompatible !== 'function'
          || provider.isControllerCompatible(activeController, request, context));

      if (publicUrl && !controllerCompatible) {
        await stop();
        publicUrl = null;
      }

      if (publicUrl && typeof provider.verifyPublicReachability === 'function') {
        await provider.verifyPublicReachability(getController(), request, context);
      }

      if (!publicUrl) {
        const availability = await provider.checkAvailability();
        if (!availability?.available) {
          const missingDependencyMessage = typeof availability?.message === 'string' && availability.message.trim().length > 0
            ? availability.message
            : (request.provider === TUNNEL_PROVIDER_CLOUDFLARE
              ? 'cloudflared is not installed. Install it with: brew install cloudflared'
              : `Required dependency for provider '${request.provider}' is missing`);
          throw new TunnelServiceError('missing_dependency', missingDependencyMessage);
        }

        const controller = await provider.start(request, context);
        controller.provider = request.provider;
        setController(controller);
        observeControllerTermination(controller);

        publicUrl = provider.resolvePublicUrl(controller);
        if (!publicUrl) {
          await stop();
          throw new TunnelServiceError('startup_failed', 'Tunnel started but no public URL was assigned');
        }

        if (request.mode === TUNNEL_MODE_QUICK) {
          onQuickTunnelWarning?.();
        }
      }

      return {
        publicUrl,
        request,
        activeMode: request.mode,
        provider: request.provider,
        controllerReused: Boolean(activeController) && getController() === activeController,
        providerMetadata: provider.getMetadata?.(getController()) ?? null,
      };
    } finally {
      releaseLock();
    }
  };

  const getPublicUrl = () => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    if (!provider) {
      return controller.getPublicUrl?.() ?? null;
    }
    return provider.resolvePublicUrl(controller);
  };

  const getProviderMetadata = () => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    return provider?.getMetadata?.(controller) ?? null;
  };

  const refreshHealth = async (options = {}) => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    await provider?.refreshHealth?.(controller, options);
    if (getController() !== controller) {
      return null;
    }
    return provider?.getMetadata?.(controller) ?? null;
  };

  return {
    start,
    stop,
    checkAvailability,
    getPublicUrl,
    getProviderMetadata,
    refreshHealth,
    resolveActiveMode,
    resolveActiveProvider,
  };
}
