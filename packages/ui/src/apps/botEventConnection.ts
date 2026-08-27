import type { BotEventsConnectionState } from '@/stores/useBotOperationsStore';

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
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

const RECONNECT_DELAYS_MS = Object.freeze([250, 1_000, 2_000, 5_000]);

export const createBotEventConnectionController = ({
  eventKinds,
  createSource,
  ingest,
  setConnectionState,
  onReconnectedSnapshot = () => {},
  initialRecoveryErrorCode = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: ConnectionControllerOptions) => {
  let source: BotEventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let started = false;
  let disposed = false;
  let hasSnapshot = false;

  const closeSource = () => {
    source?.close();
    source = null;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  };

  const connect = () => {
    if (disposed) return;
    clearReconnectTimer();
    closeSource();
    const currentGeneration = ++generation;
    setConnectionState(
      hasSnapshot ? 'reconnecting' : 'connecting',
      hasSnapshot ? null : initialRecoveryErrorCode,
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
        value = JSON.parse(message.data);
      } catch {
        scheduleReconnect('bot_event_json_invalid');
        return;
      }
      const result = ingest(value);
      if (!result.accepted) {
        if (result.reason === 'stale') return;
        scheduleReconnect(
          kind === 'snapshot'
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
      setConnectionState('connected');
      if (reconnected) onReconnectedSnapshot();
    };

    for (const kind of eventKinds) {
      nextSource.addEventListener(kind, (message) => ingestMessage(kind, message));
    }
    nextSource.onopen = () => {
      if (disposed || generation !== currentGeneration || source !== nextSource) return;
      setConnectionState(
        hasSnapshot ? 'reconnecting' : 'connecting',
        hasSnapshot ? null : initialRecoveryErrorCode,
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
    setConnectionState(
      'reconnecting',
      hasSnapshot ? errorCode : initialRecoveryErrorCode || errorCode,
    );
    const delay = RECONNECT_DELAYS_MS[Math.min(
      reconnectAttempt,
      RECONNECT_DELAYS_MS.length - 1,
    )];
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
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

type BotCapabilitySummary = Readonly<{
  state: string;
  code?: string | null;
}>;

type BotCapabilityConnectionControllerOptions = {
  loadCapabilities: () => Promise<BotCapabilitySummary | null>;
  getCapabilitiesErrorCode: () => string | null;
  canStream: (state: string) => boolean;
  isTransient: (state: string) => boolean;
  createConnection: (initialRecoveryErrorCode: string | null) => BotEventConnectionController;
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
  let started = false;
  let disposed = false;
  let hasFailure = false;
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

  async function probe() {
    if (disposed || connection) return;
    if (probing) {
      retryAfterProbe = true;
      return;
    }
    probing = true;
    if (!hasFailure) setConnectionState('connecting');
    try {
      const capabilities = await loadCapabilities().catch(() => null);
      if (disposed || connection) return;
      if (capabilities && canStream(capabilities.state)) {
        retryAttempt = 0;
        clearRetryTimer();
        try {
          connection = createConnection(lastFailureCode);
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
      if (!capabilities || isTransient(capabilities.state)) scheduleRetry();
    } finally {
      probing = false;
      if (retryAfterProbe && !disposed && !connection) {
        retryAfterProbe = false;
        retryAttempt = 0;
        clearRetryTimer();
        void probe();
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
      if (probing) retryAfterProbe = true;
      else void probe();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retryAfterProbe = false;
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
