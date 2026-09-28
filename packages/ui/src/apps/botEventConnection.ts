import type { BotEventsConnectionState } from '@/stores/useBotOperationsStore';
import { BOT_EVENT_MAX_BYTES, BOT_SNAPSHOT_PART_KIND, createBotSnapshotAssembler } from '../../../bots-runtime/event-snapshot.js';

export type BotEventSource = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

type IngestResult = Readonly<{
  accepted: boolean;
  reason: 'snapshot' | 'event' | 'invalid' | 'wrong_epoch' | 'stale';
}>;

type ConnectionControllerOptions = {
  eventKinds: readonly string[];
  createSource: () => BotEventSource;
  ingest: (value: unknown) => IngestResult;
  setConnectionState: (state: BotEventsConnectionState, errorCode?: string | null) => void;
  onReconnectedSnapshot?: () => void;
  initialRecoveryErrorCode?: string | null;
  /** This connection replaces one that already delivered a snapshot. */
  resumed?: boolean;
  /** Called on every accepted snapshot. */
  onConnected?: () => void;
  /** A transport failure (the stream closed or could not open). Returning
   * true hands recovery to the caller, which disposes this connection and
   * re-checks capabilities instead of reconnecting blindly. */
  onConnectionLost?: (errorCode: string) => boolean;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

const TRANSPORT_FAILURE_CODES = new Set(['bot_event_connection_lost', 'bot_event_connection_failed']);

const RECONNECT_DELAYS_MS = Object.freeze([250, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);

export const createBotEventConnectionController = ({
  eventKinds,
  createSource,
  ingest,
  setConnectionState,
  onReconnectedSnapshot = () => {},
  initialRecoveryErrorCode = null,
  resumed = false,
  onConnected = () => {},
  onConnectionLost = () => false,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: ConnectionControllerOptions) => {
  let source: BotEventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let started = false;
  let disposed = false;
  let hasSnapshot = resumed;
  let lastFailureCode = initialRecoveryErrorCode;
  const snapshotAssembler = createBotSnapshotAssembler();
  let receivingSnapshot = false;

  const closeSource = () => {
    source?.close();
    source = null;
    snapshotAssembler.reset();
    receivingSnapshot = false;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  };

  const connect = () => {
    if (disposed) return;
    clearReconnectTimer();
    closeSource();
    const currentGeneration = ++generation;
    setConnectionState(
      hasSnapshot ? 'reconnecting' : 'connecting',
      lastFailureCode,
    );

    let nextSource: BotEventSource;
    try {
      nextSource = createSource();
    } catch {
      scheduleReconnect('bot_event_connection_failed');
      return;
    }
    source = nextSource;

    const ingestMessage = (kind: string, message: MessageEvent<string>) => {
      if (disposed || generation !== currentGeneration || source !== nextSource) return;
      let value: unknown;
      try {
        if (message.data.length > BOT_EVENT_MAX_BYTES + 4_096) {
          scheduleReconnect('bot_event_too_large');
          return;
        }
        value = JSON.parse(message.data);
        if (kind === BOT_SNAPSHOT_PART_KIND) {
          receivingSnapshot = true;
          const complete = snapshotAssembler.push(value);
          if (!complete) return;
          receivingSnapshot = false;
          value = complete;
        } else if (receivingSnapshot) {
          scheduleReconnect('bot_event_snapshot_invalid');
          return;
        }
      } catch {
        scheduleReconnect(kind === BOT_SNAPSHOT_PART_KIND ? 'bot_event_snapshot_invalid' : 'bot_event_json_invalid');
        return;
      }
      const result = ingest(value);
      if (!result.accepted) {
        if (result.reason === 'stale') return;
        scheduleReconnect(
          kind === 'snapshot' || kind === BOT_SNAPSHOT_PART_KIND
            ? 'bot_event_snapshot_invalid'
            : result.reason === 'wrong_epoch'
              ? 'bot_event_epoch_invalid'
              : 'bot_event_envelope_invalid',
        );
        return;
      }
      if (result.reason !== 'snapshot') return;
      const reconnected = hasSnapshot;
      hasSnapshot = true;
      reconnectAttempt = 0;
      lastFailureCode = null;
      setConnectionState('connected');
      onConnected();
      if (reconnected) onReconnectedSnapshot();
    };

    for (const kind of new Set([...eventKinds, BOT_SNAPSHOT_PART_KIND])) {
      nextSource.addEventListener(kind, (message) => ingestMessage(kind, message));
    }
    nextSource.onopen = () => {
      if (disposed || generation !== currentGeneration || source !== nextSource) return;
      setConnectionState(
        hasSnapshot ? 'reconnecting' : 'connecting',
        lastFailureCode,
      );
    };
    nextSource.onerror = () => {
      if (disposed || generation !== currentGeneration || source !== nextSource) return;
      scheduleReconnect('bot_event_connection_lost');
    };
  };

  function scheduleReconnect(errorCode: string) {
    if (disposed) return;
    generation += 1;
    closeSource();
    clearReconnectTimer();
    if (TRANSPORT_FAILURE_CODES.has(errorCode) && onConnectionLost(errorCode)) {
      disposed = true;
      return;
    }
    lastFailureCode = hasSnapshot ? errorCode : lastFailureCode || errorCode;
    setConnectionState(
      'reconnecting',
      lastFailureCode,
    );
    const delay = RECONNECT_DELAYS_MS[Math.min(
      reconnectAttempt,
      RECONNECT_DELAYS_MS.length - 1,
    )];
    reconnectAttempt += 1;
    const scheduledGeneration = generation;
    reconnectTimer = setTimeoutImpl(() => {
      if (disposed || generation !== scheduledGeneration) return;
      reconnectTimer = null;
      connect();
    }, delay);
  }

  return Object.freeze({
    start() {
      if (started || disposed) return;
      started = true;
      connect();
    },
    retry() {
      if (disposed) return;
      reconnectAttempt = 0;
      connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearReconnectTimer();
      closeSource();
    },
  });
};

type BotEventConnectionController = ReturnType<typeof createBotEventConnectionController>;
type RetryableBotConnectionController = Pick<BotEventConnectionController, 'retry' | 'dispose'>;

export type BotCapabilitySummary = Readonly<{
  state: string;
  code?: string | null;
  catalogAvailable?: boolean;
  database?: Readonly<{ state: string; code?: string | null }> | null;
}>;

export type BotEventConnectionHooks = Readonly<{
  initialRecoveryErrorCode: string | null;
  resumed: boolean;
  onConnected: () => void;
  onConnectionLost: (errorCode: string) => boolean;
}>;

type BotCapabilityConnectionControllerOptions = {
  /** `refresh` asks the host for a live probe; only an explicit retry sets it. */
  loadCapabilities: (options?: { refresh?: boolean }) => Promise<BotCapabilitySummary | null>;
  getCapabilitiesErrorCode: () => string | null;
  canStream: (capabilities: BotCapabilitySummary) => boolean;
  /** Whether a non-streamable state can clear on its own. Recovery and setup
   * states cannot: they are rechecked only on an explicit retry or focus. */
  isTransient: (capabilities: BotCapabilitySummary) => boolean;
  /** A capability error that no retry can clear (for example Supabase is
   * deliberately off on this host); rechecked only on an explicit retry. */
  isFinalErrorCode?: (code: string | null) => boolean;
  createConnection: (hooks: BotEventConnectionHooks) => BotEventConnectionController;
  setConnectionState: (state: BotEventsConnectionState, errorCode?: string | null) => void;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

const CAPABILITY_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 2_000, 5_000, 15_000]);

export const createBotCapabilityConnectionController = ({
  loadCapabilities,
  getCapabilitiesErrorCode,
  canStream,
  isTransient,
  isFinalErrorCode = () => false,
  createConnection,
  setConnectionState,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: BotCapabilityConnectionControllerOptions) => {
  let connection: BotEventConnectionController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let probing = false;
  let retryAfterProbe = false;
  let refreshAfterProbe = false;
  let started = false;
  let disposed = false;
  let hasFailure = false;
  let hadSnapshot = false;
  let lastFailureCode: string | null = null;

  const clearRetryTimer = () => {
    if (retryTimer) clearTimeoutImpl(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer || connection) return;
    const delay = CAPABILITY_RETRY_DELAYS_MS[Math.min(
      retryAttempt,
      CAPABILITY_RETRY_DELAYS_MS.length - 1,
    )];
    retryAttempt += 1;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      void probe();
    }, delay);
  };

  async function probe(refresh = false) {
    if (disposed || connection) return;
    if (probing) {
      retryAfterProbe = true;
      refreshAfterProbe ||= refresh;
      return;
    }
    probing = true;
    if (!hasFailure) setConnectionState('connecting');
    try {
      const capabilities = await loadCapabilities(refresh ? { refresh: true } : undefined).catch(() => null);
      if (disposed || connection) return;
      if (capabilities && canStream(capabilities)) {
        clearRetryTimer();
        try {
          const current: BotEventConnectionController = createConnection({
            initialRecoveryErrorCode: lastFailureCode,
            resumed: hadSnapshot,
            onConnected: () => {
              hadSnapshot = true;
              hasFailure = false;
              retryAttempt = 0;
              lastFailureCode = null;
            },
            // The stream dropped: the catalog may have gone into recovery,
            // maintenance or a restart. Re-read capabilities before any
            // reconnect so recovery states stop futile retries.
            onConnectionLost: (errorCode) => {
              if (disposed || connection !== current) return false;
              connection = null;
              hasFailure = true;
              lastFailureCode = errorCode;
              setConnectionState(hadSnapshot ? 'reconnecting' : 'error', errorCode);
              scheduleRetry();
              return true;
            },
          });
          connection = current;
          connection.start();
        } catch {
          connection = null;
          hasFailure = true;
          lastFailureCode ||= 'bot_event_connection_failed';
          setConnectionState('error', lastFailureCode);
          scheduleRetry();
        }
        return;
      }

      hasFailure = true;
      lastFailureCode = capabilities?.code
        || getCapabilitiesErrorCode()
        || 'bot_request_failed';
      setConnectionState('error', lastFailureCode);
      if (capabilities ? isTransient(capabilities) : !isFinalErrorCode(lastFailureCode)) scheduleRetry();
    } finally {
      probing = false;
      const refreshNext = refreshAfterProbe;
      refreshAfterProbe = false;
      if (retryAfterProbe && !disposed && !connection) {
        retryAfterProbe = false;
        retryAttempt = 0;
        clearRetryTimer();
        void probe(refreshNext);
      }
    }
  }

  return Object.freeze({
    start() {
      if (started || disposed) return;
      started = true;
      void probe();
    },
    retry() {
      if (disposed) return;
      if (connection) {
        connection.retry();
        return;
      }
      retryAttempt = 0;
      clearRetryTimer();
      // An explicit retry must not be answered from the host's cached probe.
      void probe(true);
    },
    /** Re-checks a stopped (non-transient) failure, for example on focus. */
    recheck() {
      if (disposed || connection || retryTimer || probing || !hasFailure) return;
      retryAttempt = 0;
      void probe();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retryAfterProbe = false;
      refreshAfterProbe = false;
      clearRetryTimer();
      connection?.dispose();
      connection = null;
    },
  });
};

let activeController: RetryableBotConnectionController | null = null;

export const installBotEventConnection = (controller: RetryableBotConnectionController): void => {
  activeController?.dispose();
  activeController = controller;
};

export const releaseBotEventConnection = (controller: RetryableBotConnectionController): void => {
  controller.dispose();
  if (activeController === controller) activeController = null;
};

export const retryBotsEventConnection = (): void => activeController?.retry();
