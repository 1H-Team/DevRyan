import {
  ensureRuntimeServiceRegistered,
  retireMismatchedRuntimeService,
  runtimeServiceRequestSignal,
} from './runtime-service-startup.mjs';

// The foreground app's connection to its own background runtime service:
// bootstrap, desktop-host lease and its 10 s refresh, reconnect after an
// owner replacement, and detaching. Each connection has a local generation
// and an AbortController. Replacing or disconnecting it aborts its in-flight
// requests, and every await is followed by an identity check before the
// connection publishes state, arms the refresh timer, reconnects or reloads
// windows. Remote checks (protocol, owner, app version, lease handshake and
// reconnect instance) are unchanged.

const LEASE_REFRESH_INTERVAL_MS = 10_000;

const supersededError = (cause) => Object.assign(
  new Error('The background runtime connection was replaced', cause === undefined ? undefined : { cause }),
  { code: 'runtime_service_connection_superseded', retryable: false },
);

// Bounded by the connection deadline (5 s at most) and by the connection that
// issued it. An already expired deadline throws before anything is sent.
const connectionRequestSignal = (deadline, connectionSignal) => {
  const timeout = runtimeServiceRequestSignal(deadline);
  return connectionSignal ? AbortSignal.any([timeout, connectionSignal]) : timeout;
};

export const registerDesktopHostLease = async ({ fetch, url, broker, deadline, signal: connectionSignal }) => {
  const signal = connectionRequestSignal(deadline, connectionSignal);
  const register = (capabilities) => fetch(`${url}/api/runtime-service/desktop-host`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify({
      leaseId: broker.leaseId,
      brokerPort: broker.port,
      brokerToken: broker.token,
      capabilities,
    }),
  });
  let response = await register(broker.capabilities);
  if (response.status === 400 && broker.capabilities.includes('browser_observation')) {
    // Previous runtime-service builds reject unknown capabilities. Preserve
    // their existing desktop-host operations while explicitly leaving remote
    // observation unavailable for that mixed-version pairing.
    response = await register(broker.capabilities.filter((value) => value !== 'browser_observation'));
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error('Runtime service rejected the desktop host lease');
    error.code = response.status === 401
      ? 'runtime_service_session_required'
      : 'desktop_host_registration_failed';
    // Bounded, secret-free detail so startup logs say why the service refused.
    error.rejection = Object.freeze({
      status: response.status,
      code: typeof payload?.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(payload.code) ? payload.code : null,
    });
    throw error;
  }
  return response.json();
};

export const bootstrapRuntimeServiceSession = async ({
  fetch, url, descriptor, deadline, signal: connectionSignal, unsealBootstrapToken, setRuntimeServiceCookie,
}) => {
  const bootstrapToken = unsealBootstrapToken(descriptor);
  const bootstrap = await fetch(`${url}/auth/runtime-service-bootstrap`, {
    method: 'POST',
    signal: connectionRequestSignal(deadline, connectionSignal),
    headers: {
      'Content-Type': 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify({ token: bootstrapToken }),
  });
  if (!bootstrap.ok) {
    const error = new Error('The background runtime session could not be established');
    error.code = 'runtime_service_bootstrap_rejected';
    throw error;
  }
  // A replaced connection must not install the renderer session for its URL.
  connectionSignal?.throwIfAborted();
  await setRuntimeServiceCookie(url, bootstrap.headers.get('set-cookie'));
};

export const createRuntimeServiceConnection = ({
  state,
  appVersion,
  fetch,
  dataDirectory,
  readDescriptor,
  assertDescriptorOwner,
  isProtocolSupported,
  buildLocalUrl,
  waitForHealth,
  unsealBootstrapToken,
  setRuntimeServiceCookie,
  createBroker,
  recordAppVersion,
  getRegistration,
  waitForOwnerStopped,
  terminateProcess,
  getWindows,
  log,
  setInterval: armInterval = setInterval,
  clearInterval: disarmInterval = clearInterval,
  now = Date.now,
}) => {
  let generation = 0;
  let controller = null;
  let reconnectPromise = null;
  let retired = false;

  // Starting a connection replaces the previous one; ending it leaves none.
  const beginConnection = () => {
    controller?.abort(supersededError());
    generation += 1;
    controller = new AbortController();
    return Object.freeze({ generation, signal: controller.signal });
  };
  const endConnection = () => {
    controller?.abort(supersededError());
    generation += 1;
    controller = null;
  };
  const isCurrent = (connection) => connection.generation === generation && !connection.signal.aborted;
  const assertCurrent = (connection) => {
    if (!isCurrent(connection)) throw supersededError();
  };

  const clearRefreshTimer = () => {
    if (state.desktopHostLeaseRefreshTimer) {
      disarmInterval(state.desktopHostLeaseRefreshTimer);
      state.desktopHostLeaseRefreshTimer = null;
    }
  };

  const startDesktopHostBroker = async (connection) => {
    if (state.desktopHostBroker) return state.desktopHostBroker;
    const broker = await createBroker();
    // Only the current connection publishes a broker; a replaced one closes its own.
    if (!isCurrent(connection) || state.desktopHostBroker) {
      await broker.close().catch(() => undefined);
      assertCurrent(connection);
      return state.desktopHostBroker;
    }
    state.desktopHostBroker = broker;
    return broker;
  };

  const disconnect = async ({ notifyService = true } = {}) => {
    endConnection();
    clearRefreshTimer();
    const broker = state.desktopHostBroker;
    state.desktopHostBroker = null;
    if (notifyService && broker && state.sidecarUrl && state.runtimeServiceClient) {
      await fetch(
        `${state.sidecarUrl}/api/runtime-service/desktop-host/${encodeURIComponent(broker.leaseId)}`,
        {
          method: 'DELETE',
          headers: { 'X-DevRyan-CSRF': '1' },
        },
      ).catch(() => undefined);
    }
    await broker?.close().catch(() => undefined);
  };

  const bootstrap = (url, descriptor, deadline, signal) => bootstrapRuntimeServiceSession({
    fetch, url, descriptor, deadline, signal, unsealBootstrapToken, setRuntimeServiceCookie,
  });

  // prepare-update exists since the first runtime-service release (1.1.7), so a
  // service from any older version can be drained through it.
  const retireStaleRuntimeService = (descriptor, url, deadline) => retireMismatchedRuntimeService({
    descriptor,
    appVersion,
    log,
    drain: async () => {
      if (!await waitForHealth(url, 5_000, 100)) {
        throw Object.assign(new Error('The background runtime is not ready'), { code: 'runtime_service_unavailable' });
      }
      await bootstrap(url, descriptor, deadline);
      const response = await fetch(`${url}/api/runtime-service/prepare-update`, {
        method: 'POST',
        signal: runtimeServiceRequestSignal(deadline),
        headers: { 'X-DevRyan-CSRF': '1' },
      });
      if (!response.ok) {
        throw Object.assign(new Error('The background runtime did not accept the drain'), {
          code: 'runtime_service_update_prepare_failed',
        });
      }
    },
    unregister: () => getRegistration().unregister(),
    waitForStopped: (timeoutMs) => waitForOwnerStopped(timeoutMs),
    terminate: (signal) => terminateProcess({ pid: descriptor.pid, signal }),
    register: () => ensureRuntimeServiceRegistered({ registration: getRegistration(), log }),
  });

  // A failed refresh reconnects only when the descriptor names another owner,
  // and only app windows attached to the replaced owner are reloaded. A
  // deferred reconnect keeps refreshing the replaced owner, so the next failed
  // refresh retries it.
  const reconnectAfterRefreshFailure = (connection, descriptor, url, broker) => {
    if (reconnectPromise) return;
    const current = (async () => {
      const fresh = await readDescriptor({ dataDirectory: dataDirectory() });
      if (!isCurrent(connection)) return;
      if (fresh.instanceId === descriptor.instanceId) return;
      const next = beginConnection();
      let nextUrl;
      try {
        nextUrl = await attach({ reconnecting: true, connection: next });
      } catch (failure) {
        if (!isCurrent(next)) return;
        log.warn('[runtime-service] reconnect deferred', { code: failure?.code || 'runtime_service_unavailable' });
        armLeaseRefresh(next, descriptor, url, broker);
        return;
      }
      for (const window of getWindows()) {
        if (!isCurrent(next)) return;
        if (window.isDestroyed()) continue;
        const previous = window.webContents.getURL();
        if (!previous.startsWith(`${url}/`)) continue;
        await window.loadURL(`${nextUrl}${previous.slice(url.length)}`);
      }
    })().catch((failure) => {
      log.warn('[runtime-service] reconnect deferred', { code: failure?.code || 'runtime_service_unavailable' });
    }).finally(() => {
      if (reconnectPromise === current) reconnectPromise = null;
    });
    reconnectPromise = current;
  };

  const armLeaseRefresh = (connection, descriptor, url, broker) => {
    clearRefreshTimer();
    state.desktopHostLeaseRefreshTimer = armInterval(() => {
      if (!isCurrent(connection)) return;
      void registerDesktopHostLease({ fetch, url, broker, signal: connection.signal }).catch((error) => {
        if (!isCurrent(connection)) return;
        log.warn('[runtime-service] desktop host lease refresh failed', {
          code: error?.code || 'desktop_host_registration_failed',
          ...(error?.rejection ? { rejection: error.rejection } : {}),
        });
        reconnectAfterRefreshFailure(connection, descriptor, url, broker);
      });
    }, LEASE_REFRESH_INTERVAL_MS);
    state.desktopHostLeaseRefreshTimer.unref?.();
  };

  const attach = async ({ reconnecting = false, deadline = now() + 20_000, connection = beginConnection() } = {}) => {
    let brokerStarted = false;
    try {
      const descriptor = await readDescriptor({ dataDirectory: dataDirectory() });
      assertCurrent(connection);
      if (!isProtocolSupported(descriptor.protocolVersion)) {
        const error = new Error('The background runtime protocol is not supported by this app version');
        error.code = 'runtime_service_protocol_mismatch';
        throw error;
      }
      await assertDescriptorOwner({ dataDirectory: dataDirectory(), descriptor });
      assertCurrent(connection);
      const url = buildLocalUrl(descriptor.port).replace(/\/$/, '');
      // A protocol match is not enough: a live service of another app version
      // would keep its old server (1.x: v1 OpenCode) and skip this version's
      // provisioning. It is retired once; it is never attached.
      if (descriptor.appVersion !== appVersion) {
        if (reconnecting || retired) {
          throw Object.assign(new Error('The background runtime belongs to another app version'), {
            code: 'runtime_service_version_mismatch', retryable: false,
          });
        }
        retired = true;
        await retireStaleRuntimeService(descriptor, url, deadline);
        throw Object.assign(new Error('The background runtime is restarting for this app version'), {
          code: 'runtime_service_unavailable',
        });
      }
      if (!await waitForHealth(url, Math.max(0, Math.min(5_000, deadline - now())), 100)) {
        const error = new Error('The background runtime is not ready');
        error.code = 'runtime_service_unavailable';
        throw error;
      }
      assertCurrent(connection);
      await assertDescriptorOwner({ dataDirectory: dataDirectory(), descriptor });
      assertCurrent(connection);
      await bootstrap(url, descriptor, deadline, connection.signal);
      assertCurrent(connection);
      const broker = await startDesktopHostBroker(connection);
      brokerStarted = true;
      const status = await registerDesktopHostLease({ fetch, url, broker, deadline, signal: connection.signal });
      assertCurrent(connection);
      if (status?.instanceId !== descriptor.instanceId
        || status?.ownerGeneration !== descriptor.ownerGeneration
        || status?.protocolVersion !== descriptor.protocolVersion) {
        const error = new Error('The background runtime changed during connection');
        error.code = 'runtime_service_generation_changed';
        throw error;
      }
      state.runtimeServiceClient = true;
      state.sidecarUrl = url;
      await recordAppVersion();
      assertCurrent(connection);
      armLeaseRefresh(connection, descriptor, url, broker);
      return url;
    } catch (error) {
      // A replaced connection reports replacement, never a retryable abort,
      // and leaves the broker to the connection that replaced it.
      if (!isCurrent(connection)) {
        throw error?.code === 'runtime_service_connection_superseded' ? error : supersededError(error);
      }
      if (brokerStarted && !reconnecting) await disconnect({ notifyService: false });
      throw error;
    }
  };

  return Object.freeze({
    connect: ({ reconnecting, deadline } = {}) => attach({ reconnecting, deadline }),
    disconnect,
  });
};
