import { assertBotJsonValue } from '@openchamber/bots-runtime';

import {
  isPublicBotAssistantTextPart,
  sanitizeBotConversationalText,
} from './response-sanitizer.js';

export const BOT_REASONING_ADAPTER_KINDS = Object.freeze(['opencode', 'ag_ui']);
export const BOT_REASONING_EVENT_KINDS = Object.freeze([
  'run.started',
  'assistant.message',
  'assistant.text',
  'governed_tool.intent',
  'artifact',
  'checkpoint',
  'usage',
  'run.completed',
  'run.error',
]);

const REQUIRED_METHODS = Object.freeze([
  'health',
  'prepareRevision',
  'startRun',
  'continueRun',
  'inspectRun',
  'cancelRun',
  'closeRun',
  'completeStructured',
]);

export class BotReasoningAdapterError extends Error {
  constructor(message, code = 'bot_agent_adapter_invalid', statusCode = 400, diagnostics = null) {
    super(message);
    this.name = 'BotReasoningAdapterError';
    this.code = code;
    this.statusCode = statusCode;
    this.diagnostics = diagnostics ? Object.freeze({ ...diagnostics }) : null;
  }
}

export const resolveBotReasoningBinding = (contract = {}) => {
  const candidate = contract?.agent;
  if (candidate === undefined) {
    return Object.freeze({ kind: 'opencode', models: contract?.models || null, legacy: true });
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !BOT_REASONING_ADAPTER_KINDS.includes(candidate.kind)) {
    throw new BotReasoningAdapterError('Bot reasoning adapter binding is invalid');
  }
  if (candidate.kind === 'opencode') {
    return Object.freeze({ kind: 'opencode', models: candidate.models, legacy: false });
  }
  return Object.freeze({
    kind: 'ag_ui',
    connectionRef: candidate.connectionRef,
    connectionDigest: candidate.connectionDigest,
    modelHint: candidate.modelHint || null,
    legacy: false,
  });
};

export const assertBotReasoningAdapter = (adapter, expectedKind = null) => {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)
    || !BOT_REASONING_ADAPTER_KINDS.includes(adapter.kind)
    || (expectedKind !== null && adapter.kind !== expectedKind)
    || REQUIRED_METHODS.some((method) => typeof adapter[method] !== 'function')
    || (adapter.warm !== undefined && typeof adapter.warm !== 'function')
    || (adapter.releaseWarm !== undefined && typeof adapter.releaseWarm !== 'function')) {
    throw new BotReasoningAdapterError(
      'Bot reasoning adapter does not conform to the required contract',
      'bot_agent_adapter_configuration_invalid',
      500,
    );
  }
  return adapter;
};

export const createBotReasoningAdapterRegistry = ({ adapters = [] } = {}) => {
  if (!Array.isArray(adapters)) {
    throw new BotReasoningAdapterError(
      'Bot reasoning adapter registry is invalid',
      'bot_agent_adapter_configuration_invalid',
      500,
    );
  }
  const byKind = new Map();
  for (const candidate of adapters) {
    const adapter = assertBotReasoningAdapter(candidate);
    if (byKind.has(adapter.kind)) {
      throw new BotReasoningAdapterError(
        'Bot reasoning adapter registry contains duplicates',
        'bot_agent_adapter_configuration_invalid',
        500,
      );
    }
    byKind.set(adapter.kind, adapter);
  }
  return Object.freeze({
    kinds: Object.freeze([...byKind.keys()].sort()),
    get(kind) {
      const adapter = byKind.get(kind);
      if (!adapter) {
        throw new BotReasoningAdapterError(
          'Selected Bot reasoning adapter is unavailable',
          'bot_agent_adapter_unavailable',
          503,
        );
      }
      return adapter;
    },
    forRevision(contract) {
      const binding = resolveBotReasoningBinding(contract);
      return Object.freeze({ binding, adapter: this.get(binding.kind) });
    },
  });
};

export const createBotReasoningEvent = (kind, payload = {}) => {
  if (!BOT_REASONING_EVENT_KINDS.includes(kind)
    || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BotReasoningAdapterError('Bot reasoning event is invalid');
  }
  try {
    assertBotJsonValue(payload, 'Bot reasoning event payload');
  } catch (error) {
    throw new BotReasoningAdapterError(error.message);
  }
  return Object.freeze({ kind, payload: Object.freeze(structuredClone(payload)) });
};

export const projectBotReasoningResponse = (parts) => {
  const ordered = Array.isArray(parts) ? parts : [];
  const firstToolIndex = ordered.findIndex((part) => part?.type === 'tool');
  const publicText = (values) => sanitizeBotConversationalText(values
    .filter(isPublicBotAssistantTextPart)
    .map((part) => part.text)
    .join(''));
  if (firstToolIndex < 0) {
    return Object.freeze({
      toolObserved: false,
      acknowledgmentText: '',
      resultText: publicText(ordered),
    });
  }
  let lastToolIndex = firstToolIndex;
  for (let index = firstToolIndex + 1; index < ordered.length; index += 1) {
    if (ordered[index]?.type === 'tool') lastToolIndex = index;
  }
  return Object.freeze({
    toolObserved: true,
    acknowledgmentText: publicText(ordered.slice(0, firstToolIndex)),
    resultText: publicText(ordered.slice(lastToolIndex + 1)),
  });
};

export const genericExecutionFromLegacyRun = (run) => {
  if (run?.agent_adapter) {
    return Object.freeze({
      adapter: run.agent_adapter,
      threadId: run.agent_thread_id || null,
      execution: Object.freeze(structuredClone(run.agent_execution || {})),
    });
  }
  if (run?.opencode_session_id || run?.opencode_segment_id) {
    return Object.freeze({
      adapter: 'opencode',
      threadId: run.opencode_session_id || null,
      execution: Object.freeze({
        version: 1,
        adapter: 'opencode',
        threadId: run.opencode_session_id || null,
        segmentId: run.opencode_segment_id || null,
        checkpointVersion: 1,
      }),
    });
  }
  return Object.freeze({ adapter: null, threadId: null, execution: Object.freeze({}) });
};
