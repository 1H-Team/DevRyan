import { assertBotJsonValue } from '@openchamber/bots-runtime';

import {
  sanitizeBotConversationalTextParts,
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
export const BOT_REASONING_PREPARATION_PERSISTENCE = Object.freeze(['durable', 'ephemeral']);

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

export const normalizeBotReasoningPreparationPersistence = (value = 'durable') => {
  if (!BOT_REASONING_PREPARATION_PERSISTENCE.includes(value)) {
    throw new BotReasoningAdapterError(
      'Bot reasoning preparation persistence is invalid',
      'bot_agent_adapter_invalid',
      400,
    );
  }
  return value;
};

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

const MAX_ACKNOWLEDGMENT_CHARS = 400;

// The first short thing a Bot says before it starts tool work is its
// acknowledgment ("on it, give me a sec"). It is bounded so a long pre-tool
// essay never becomes a durable acknowledgment row.
const boundedAcknowledgment = (text) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return '';
  if (trimmed.length <= MAX_ACKNOWLEDGMENT_CHARS) return trimmed;
  const cut = trimmed.slice(0, MAX_ACKNOWLEDGMENT_CHARS);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return sentenceEnd > 40 ? cut.slice(0, sentenceEnd + 1) : cut;
};

export const projectBotReasoningResponse = (parts) => {
  const ordered = Array.isArray(parts) ? parts : [];
  const firstToolIndex = ordered.findIndex((part) => part?.type === 'tool');
  const publicText = (values) => sanitizeBotConversationalTextParts(values);
  if (firstToolIndex < 0) {
    return Object.freeze({
      toolObserved: false,
      acknowledgmentText: '',
      resultText: publicText(ordered),
      resultFallback: false,
    });
  }
  let lastToolIndex = firstToolIndex;
  for (let index = firstToolIndex + 1; index < ordered.length; index += 1) {
    if (ordered[index]?.type === 'tool') lastToolIndex = index;
  }
  let resultText = publicText(ordered.slice(lastToolIndex + 1));
  let resultFallback = false;
  if (!resultText.trim()) {
    // The model answered and then made one more tool call without a closing
    // message. The last complete prose segment between tool boundaries is the
    // answer it wrote; use it rather than reporting no response at all.
    let end = lastToolIndex;
    while (end > firstToolIndex && !resultText.trim()) {
      let start = end - 1;
      while (start > firstToolIndex && ordered[start]?.type !== 'tool') start -= 1;
      resultText = publicText(ordered.slice(start + 1, end));
      end = start;
    }
    resultFallback = Boolean(resultText.trim());
    if (!resultFallback) resultText = '';
  }
  return Object.freeze({
    toolObserved: true,
    acknowledgmentText: boundedAcknowledgment(publicText(ordered.slice(0, firstToolIndex))),
    resultText,
    resultFallback,
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
