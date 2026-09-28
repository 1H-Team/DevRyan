import { createSupabaseServerClient, SupabaseRequestError } from '../multi-user/supabase-client.js';
import { createSupabaseTraffic } from '../multi-user/supabase-traffic.js';

// Narrow transport from the unchanged Bot repositories to the local catalog.
// The REST/RPC client is reused as-is; only the Kong `/rest/v1` mount point is
// stripped for bare PostgREST, and Storage calls go to the encrypted-file
// adapter directly. Endpoints and tokens come from the Electron-owned catalog
// and never leave this process.
//
// Failure rules:
// - a refused connection was never delivered: refresh the context and retry once;
// - an expired or rejected token was refused before execution: refresh and retry once;
// - any other transport failure is ambiguous and is never replayed for a
//   mutation; reads may be retried once after a context refresh.

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const START_RETRY_MIN_MS = 2_000;
const START_RETRY_MAX_MS = 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const JWT_REJECTION_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303']);

const connectionCode = (error) => {
  const cause = error?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : (typeof error?.code === 'string' ? error.code : '');
  return code;
};

// Node (undici) reports ECONNREFUSED on the cause; Bun reports ConnectionRefused
// or FailedToOpenSocket on the error. Either way nothing was delivered.
const REFUSED_CODES = new Set(['ECONNREFUSED', 'ConnectionRefused', 'FailedToOpenSocket']);
const TRANSPORT_CODES = new Set([
  ...REFUSED_CODES,
  'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ConnectionClosed',
]);

const isRefusedConnection = (error) => REFUSED_CODES.has(connectionCode(error));

const isTransportFailure = (error) => (
  !(error instanceof SupabaseRequestError)
  && (error instanceof TypeError
    || TRANSPORT_CODES.has(connectionCode(error))
    || error?.name === 'TimeoutError' || error?.name === 'AbortError')
);

const isTokenRejection = (error) => (
  error instanceof SupabaseRequestError
  && error.status === 401
  && JWT_REJECTION_CODES.has(error.payload?.code)
);

const unavailable = (code = 'bot_database_unavailable', cause = null) => {
  const error = new SupabaseRequestError('The local Bot catalog is unavailable', { status: 503 });
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

const validateContext = (context) => {
  let url;
  try {
    url = new URL(context?.url);
  } catch {
    throw unavailable('bot_database_context_invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || typeof context.token !== 'string' || context.token.split('.').length !== 3
    || !Number.isFinite(Date.parse(context.expiresAt))
    || !Number.isSafeInteger(context.generation)) {
    throw unavailable('bot_database_context_invalid');
  }
  return Object.freeze({
    origin: url.origin,
    token: context.token,
    expiresAtMs: Date.parse(context.expiresAt),
    generation: context.generation,
  });
};

export function createLocalBotCatalogTransport({
  catalog,
  objectStorage,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  if (typeof catalog?.getContext !== 'function' || typeof catalog?.ensure !== 'function') {
    throw new TypeError('The local Bot catalog provider is required');
  }
  if (typeof objectStorage?.storageUpload !== 'function'
    || typeof objectStorage?.storageDownload !== 'function'
    || typeof objectStorage?.storageDelete !== 'function') {
    throw new TypeError('The local Bot object storage is required');
  }
  const traffic = createSupabaseTraffic({ now });
  const listeners = new Set();
  let current = null;
  let contextPromise = null;
  let startPromise = null;
  let retryTimer = null;
  let retryDelayMs = START_RETRY_MIN_MS;
  let state = Object.freeze({ state: 'starting', code: null, generation: 0 });
  let disposed = false;

  const publish = (next) => {
    if (next.state === state.state && next.code === state.code && next.generation === state.generation) return;
    const previous = state;
    state = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener(state, previous);
      } catch {
        // Readiness listeners must never break a catalog request.
      }
    }
  };

  const markReady = (generation) => {
    retryDelayMs = START_RETRY_MIN_MS;
    publish({ state: 'ready', code: null, generation });
  };

  const markUnavailable = (code, stateName = 'unavailable') => {
    current = null;
    publish({ state: stateName, code, generation: state.generation });
  };

  const buildClient = (context) => createSupabaseServerClient({
    url: context.origin,
    publishableKey: '',
    secretKey: context.token,
    traffic,
    fetchImpl: (target, options) => {
      const parsed = new URL(target);
      if (parsed.origin !== context.origin) {
        return Promise.reject(unavailable('bot_database_target_invalid'));
      }
      if (!/^\/rest\/v1(?:\/|$)/.test(parsed.pathname)) {
        return Promise.reject(unavailable('bot_database_target_invalid'));
      }
      parsed.pathname = parsed.pathname.slice('/rest/v1'.length) || '/';
      return fetchImpl(parsed, options);
    },
  });

  const loadContext = async () => {
    contextPromise ||= (async () => {
      let raw;
      try {
        raw = await catalog.getContext();
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'bot_database_unavailable';
        throw unavailable(code, error);
      }
      const context = validateContext(raw);
      current = Object.freeze({ ...context, client: buildClient(context) });
      return current;
    })().finally(() => {
      contextPromise = null;
    });
    return contextPromise;
  };

  const client = async () => {
    if (disposed) throw unavailable('bot_database_disposed');
    if (current && current.expiresAtMs - now() > TOKEN_REFRESH_MARGIN_MS) return current;
    return loadContext();
  };

  const invalidate = () => {
    current = null;
  };

  const execute = async (method, operation) => {
    let context;
    try {
      context = await client();
    } catch (error) {
      markUnavailable(error?.code || 'bot_database_unavailable');
      scheduleStart();
      throw error;
    }
    const attempt = async (activeContext) => {
      try {
        const result = await operation(activeContext.client);
        if (state.state !== 'ready' || state.generation !== activeContext.generation) {
          markReady(activeContext.generation);
        }
        return result;
      } catch (error) {
        if (isTokenRejection(error) || isTransportFailure(error)) invalidate();
        throw error;
      }
    };
    try {
      return await attempt(context);
    } catch (error) {
      const retrySafe = isTokenRejection(error)
        || isRefusedConnection(error)
        || (isTransportFailure(error) && SAFE_METHODS.has(method));
      if (!retrySafe) {
        if (isTransportFailure(error)) {
          markUnavailable('bot_database_unavailable');
          scheduleStart();
          throw unavailable('bot_database_unavailable', error);
        }
        throw error;
      }
      let refreshed;
      try {
        refreshed = await loadContext();
      } catch (refreshError) {
        markUnavailable(refreshError?.code || 'bot_database_unavailable');
        scheduleStart();
        throw refreshError;
      }
      try {
        return await attempt(refreshed);
      } catch (retryError) {
        if (isTransportFailure(retryError)) {
          markUnavailable('bot_database_unavailable');
          scheduleStart();
          throw unavailable('bot_database_unavailable', retryError);
        }
        throw retryError;
      }
    }
  };

  // One readiness engine: a failed catalog is started again through the
  // Electron lifecycle queue with bounded backoff. Starting never installs
  // images; it can only start an existing installation.
  const ensureStarted = async () => {
    startPromise ||= (async () => {
      try {
        await loadContext();
      } catch (contextError) {
        if (contextError?.code !== 'bot_database_unavailable') throw contextError;
        try {
          await catalog.ensure();
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'bot_database_unavailable';
          throw unavailable(code, error);
        }
        await loadContext();
      }
      const probe = await current.client.rpc('devryan_bot_schema_version', {});
      if (typeof probe !== 'string') throw unavailable('bot_database_unavailable');
      markReady(current.generation);
      return state;
    })().catch((error) => {
      const code = typeof error?.code === 'string' ? error.code : 'bot_database_unavailable';
      markUnavailable(code, classifyState(code));
      throw error;
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  function classifyState(code) {
    if (/^bot_database_(?:volume_missing|volume_foreign|identity_changed|cluster_missing|state_ambiguous|schema_newer|schema_unknown)$/.test(code)) {
      return 'recovery_required';
    }
    if (code === 'bot_runtime_setup_required' || code === 'bot_database_setup_required') return 'setup_required';
    if (code === 'bot_runtime_update_required') return 'update_required';
    if (code === 'bot_runtime_operation_busy') return 'starting';
    return 'unavailable';
  }

  function scheduleStart() {
    if (disposed || retryTimer || state.state === 'recovery_required' || state.state === 'maintenance') return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(START_RETRY_MAX_MS, retryDelayMs * 2);
    retryTimer = setTimer(() => {
      retryTimer = null;
      void ensureStarted().catch((error) => {
        if (state.state !== 'recovery_required' && state.state !== 'setup_required') scheduleStart();
        logger?.debug?.('[BotsCatalog] catalog start deferred', { code: error?.code || 'bot_database_unavailable' });
      });
    }, delay);
    retryTimer.unref?.();
  }

  return Object.freeze({
    traffic,
    get available() { return !disposed; },
    rest: (table, options = {}) => execute(String(options.method || 'GET').toUpperCase(), (active) => active.rest(table, options)),
    rpc: (name, args = {}) => execute('POST', (active) => active.rpc(name, args)),
    storageUpload: (...args) => objectStorage.storageUpload(...args),
    storageDownload: (...args) => objectStorage.storageDownload(...args),
    storageDelete: (...args) => objectStorage.storageDelete(...args),
    getState: () => state,
    ensureStarted,
    scheduleStart,
    // An explicit owner retry does not wait out the backoff. Only a plain
    // outage restarts this way: recovery, setup, update and maintenance keep
    // requiring their own owner action, and a start in flight is reused.
    retryNow() {
      if (disposed || state.state !== 'unavailable') return false;
      void ensureStarted().catch((error) => {
        if (state.state !== 'recovery_required' && state.state !== 'setup_required') scheduleStart();
        logger?.debug?.('[BotsCatalog] catalog retry deferred', { code: error?.code || 'bot_database_unavailable' });
      });
      return true;
    },
    // Maintenance and replacement: callers stop using the current endpoint
    // and wait for a new generation before reopening writes.
    enterMaintenance(code = 'bots_maintenance') {
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
      invalidate();
      publish({ state: 'maintenance', code, generation: state.generation });
    },
    leaveMaintenance() {
      invalidate();
      publish({ state: 'starting', code: null, generation: state.generation });
      return ensureStarted();
    },
    // Recovery states clear only after an explicit owner action succeeds.
    resetRecovery() {
      if (state.state === 'recovery_required' || state.state === 'setup_required') {
        publish({ state: 'starting', code: null, generation: state.generation });
      }
    },
    invalidate,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
      current = null;
      listeners.clear();
    },
  });
}
