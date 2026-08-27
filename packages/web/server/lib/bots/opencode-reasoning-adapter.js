import { randomUUID } from 'node:crypto';

import { projectBotAssistantResponse } from './opencode-provider.js';
import {
  BotReasoningAdapterError,
  createBotReasoningEvent,
} from './reasoning-adapter.js';

const SESSION_ERROR_KINDS = Object.freeze({
  ProviderAuthError: Object.freeze({ interruptionKind: 'bot_opencode_provider_authentication', retryable: false }),
  UnknownError: Object.freeze({ interruptionKind: 'bot_opencode_provider_unknown', retryable: true }),
  MessageOutputLengthError: Object.freeze({ interruptionKind: 'bot_opencode_output_length', retryable: true }),
  MessageAbortedError: Object.freeze({ interruptionKind: 'bot_opencode_message_aborted', retryable: true }),
  StructuredOutputError: Object.freeze({ interruptionKind: 'bot_opencode_structured_output', retryable: true }),
  ContextOverflowError: Object.freeze({ interruptionKind: 'bot_opencode_context_overflow', retryable: true }),
  ContentFilterError: Object.freeze({ interruptionKind: 'bot_opencode_content_filter', retryable: false }),
});

const boundedProviderReference = (error) => {
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const candidate = data.requestID || data.requestId || data.providerRequestId
    || metadata.requestID || metadata.requestId || null;
  return typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(candidate)
    ? candidate
    : null;
};

export const classifyOpenCodeRunError = (error) => {
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  const providerErrorType = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(error.name)
    ? error.name
    : 'UnknownError';
  const rawStatus = data.statusCode ?? data.status ?? error?.statusCode ?? error?.status;
  const statusCode = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null;
  const explicitRetryable = typeof data.isRetryable === 'boolean'
    ? data.isRetryable
    : (typeof error?.isRetryable === 'boolean' ? error.isRetryable : null);
  let classified = SESSION_ERROR_KINDS[providerErrorType] || SESSION_ERROR_KINDS.UnknownError;
  if (providerErrorType === 'APIError') {
    const retryable = explicitRetryable ?? (
      statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429
      || (statusCode !== null && statusCode >= 500)
    );
    classified = {
      interruptionKind: retryable ? 'bot_opencode_api_retryable' : 'bot_opencode_api_rejected',
      retryable,
    };
  }
  return Object.freeze({
    providerErrorType,
    statusCode,
    retryable: explicitRetryable ?? classified.retryable,
    providerReference: boundedProviderReference(error),
    interruptionKind: classified.interruptionKind,
  });
};

const propertiesFor = (event) => (
  event?.properties && typeof event.properties === 'object' ? event.properties : {}
);

const threadIdFor = (event) => {
  const properties = propertiesFor(event);
  return properties.sessionID || properties.info?.sessionID || properties.part?.sessionID || null;
};

export function createOpenCodeReasoningAdapter({
  provider,
  loadModelCatalog = null,
  prewarmCache = null,
  uuid = randomUUID,
} = {}) {
  if (!provider || typeof provider.start !== 'function'
    || typeof provider.startReasoningRun !== 'function'
    || typeof provider.createSegment !== 'function'
    || typeof provider.prompt !== 'function'
    || typeof provider.inspectSegment !== 'function'
    || typeof provider.abort !== 'function'
    || typeof provider.stopReasoningRun !== 'function'
    || (loadModelCatalog !== null && typeof loadModelCatalog !== 'function')
    || (prewarmCache !== null
      && (typeof prewarmCache.prewarm !== 'function'
        || typeof prewarmCache.peekCompiled !== 'function'))
    || typeof uuid !== 'function') {
    throw new TypeError('OpenCode reasoning adapter is misconfigured');
  }
  const listeners = new Map();

  provider.setEventHandler?.(async ({ runId, event }) => {
    const listener = listeners.get(runId);
    if (!listener || !event) return false;
    const properties = propertiesFor(event);
    const threadId = threadIdFor(event);
    if (listener.threadId && threadId && listener.threadId !== threadId) return false;
    let normalized = null;
    if (event.type === 'message.updated') {
      const info = properties.info;
      normalized = createBotReasoningEvent('assistant.message', {
        messageId: info?.id || '',
        role: info?.role || '',
        tokens: info?.tokens || {},
      });
    } else if (event.type === 'message.part.updated') {
      const part = properties.part;
      if (part?.type === 'text') {
        normalized = createBotReasoningEvent('assistant.text', {
          messageId: part.messageID,
          partId: part.id,
          text: part.text,
          mode: 'replace',
          ignored: part.ignored === true,
          synthetic: part.synthetic === true,
        });
      } else if (part?.type === 'tool') {
        normalized = createBotReasoningEvent('governed_tool.intent', {
          messageId: part.messageID,
          partId: part.id,
          boundaryOnly: true,
        });
      }
    } else if (event.type === 'message.part.delta') {
      if (properties.field === 'text') {
        normalized = createBotReasoningEvent('assistant.text', {
          messageId: properties.messageID,
          partId: properties.partID,
          text: properties.delta,
          mode: 'append',
        });
      }
    } else if (event.type === 'session.error') {
      const diagnostics = classifyOpenCodeRunError(properties.error);
      normalized = createBotReasoningEvent('run.error', {
        code: diagnostics.interruptionKind,
        retryable: diagnostics.retryable,
        diagnostics,
      });
    } else if (event.type === 'session.status' && properties.status?.type === 'idle') {
      normalized = createBotReasoningEvent('run.completed', {});
    }
    if (!normalized) return false;
    await listener.onEvent(normalized);
    return true;
  });

  return Object.freeze({
    kind: 'opencode',
    async health() {
      await provider.start();
      return Object.freeze({ ok: true, adapter: 'opencode' });
    },
    async prepareRevision(input) {
      const preparedInput = (catalog) => {
        const compiled = input.compiled || prewarmCache?.peekCompiled(
          input.run.channelId,
          input.run.revisionId,
        ) || null;
        return {
          ...input,
          catalog,
          ...(compiled ? { compiled } : {}),
        };
      };
      let catalog = input.catalog;
      if (catalog === undefined && loadModelCatalog) catalog = await loadModelCatalog();
      let result;
      try {
        result = await provider.startReasoningRun(preparedInput(catalog ?? null));
      } catch (error) {
        if (error?.code !== 'bot_model_unavailable' || !loadModelCatalog) throw error;
        catalog = await loadModelCatalog({ force: true });
        result = await provider.startReasoningRun(preparedInput(catalog));
      }
      return Object.freeze({ modelSnapshot: result.modelSnapshot, prepared: result });
    },
    async startRun({ runId, title, execution = null, continuation = null }) {
      const effectiveExecution = execution || (continuation && continuation.create === false
        ? continuation.execution
        : null);
      const threadId = effectiveExecution?.threadId || null;
      if (threadId) {
        return Object.freeze({
          threadId,
          execution: Object.freeze({
            version: 1,
            adapter: 'opencode',
            threadId,
            segmentId: effectiveExecution.segmentId || null,
            checkpointVersion: Number(effectiveExecution.checkpointVersion) || 1,
          }),
          legacyProjection: Object.freeze({
            opencode_session_id: threadId,
            opencode_segment_id: effectiveExecution.segmentId || null,
          }),
        });
      }
      const session = await provider.createSegment({ runId, title });
      const segmentId = effectiveExecution?.segmentId || uuid();
      return Object.freeze({
        threadId: session.id,
        execution: Object.freeze({
          version: 1,
          adapter: 'opencode',
          threadId: session.id,
          segmentId,
          checkpointVersion: 1,
        }),
        legacyProjection: Object.freeze({
          opencode_session_id: session.id,
          opencode_segment_id: segmentId,
        }),
      });
    },
    async continueRun({ runId, handle, parts, onEvent }) {
      listeners.set(runId, { threadId: handle.threadId, onEvent });
      await provider.prompt({ runId, sessionId: handle.threadId, parts });
      return Object.freeze({ accepted: true, handle });
    },
    async inspectRun({ runId, handle }) {
      const inspection = await provider.inspectSegment({ runId, sessionId: handle.threadId });
      return Object.freeze({
        ...inspection,
        assistantProjection: inspection.assistantProjection
          || projectBotAssistantResponse([]),
      });
    },
    async cancelRun({ runId, handle }) {
      listeners.delete(runId);
      await provider.abort({ runId, sessionId: handle?.threadId });
    },
    async closeRun({ runId }) {
      listeners.delete(runId);
      await provider.stopReasoningRun(runId);
    },
    async completeStructured(input) {
      if (typeof provider.runNoToolsStructured !== 'function') {
        throw new BotReasoningAdapterError(
          'OpenCode structured completion is unavailable',
          'bot_agent_structured_completion_unavailable',
          503,
        );
      }
      return provider.runNoToolsStructured(input);
    },
    async exportArtifact({ runId, path }) {
      if (typeof provider.exportGeneratedImage !== 'function') {
        throw new BotReasoningAdapterError(
          'OpenCode artifact export is unavailable',
          'bot_artifact_export_unavailable',
          503,
        );
      }
      return provider.exportGeneratedImage({ runId, path });
    },
    async warm(input) {
      prewarmCache?.prewarm({
        channelId: input.run.channelId,
        revisionId: input.run.revisionId,
        contract: input.contract,
      });
      return this.prepareRevision(input);
    },
    async releaseWarm({ runId }) {
      return this.closeRun({ runId });
    },
  });
}
