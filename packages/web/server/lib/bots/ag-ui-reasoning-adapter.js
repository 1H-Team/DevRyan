import crypto, { randomUUID } from 'node:crypto';

import {
  EventType,
  RunAgentInputSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  StepFinishedEventSchema,
  StepStartedEventSchema,
  ReasoningEndEventSchema,
  ReasoningMessageChunkEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ReasoningMessageStartEventSchema,
  ReasoningStartEventSchema,
  TextMessageChunkEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallChunkEventSchema,
  ToolCallEndEventSchema,
  ToolCallStartEventSchema,
} from '@ag-ui/core';
import {
  canonicalizeBotJson,
  hashCanonicalBotJson,
  parseStrictJson,
} from '@openchamber/bots-runtime';

import {
  BotReasoningAdapterError,
  createBotReasoningEvent,
} from './reasoning-adapter.js';

const AG_UI_PROTOCOL_VERSION = 'ag-ui/v1';
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 192 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_EVENT_COUNT = 4_096;
const MAX_ID_BYTES = 256;
const LIMIT_FIELDS = Object.freeze([
  'healthTimeoutMs',
  'maximumArgumentBytes',
  'maximumEventCount',
  'maximumStreamBytes',
  'maximumTextBytes',
  'requestTimeoutMs',
]);
const ALLOWED_EVENT_TYPES = new Set([
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_CHUNK,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
]);

const EVENT_SCHEMAS = new Map([
  [EventType.RUN_STARTED, RunStartedEventSchema],
  [EventType.TEXT_MESSAGE_START, TextMessageStartEventSchema],
  [EventType.TEXT_MESSAGE_CONTENT, TextMessageContentEventSchema],
  [EventType.TEXT_MESSAGE_END, TextMessageEndEventSchema],
  [EventType.TEXT_MESSAGE_CHUNK, TextMessageChunkEventSchema],
  [EventType.TOOL_CALL_START, ToolCallStartEventSchema],
  [EventType.TOOL_CALL_ARGS, ToolCallArgsEventSchema],
  [EventType.TOOL_CALL_END, ToolCallEndEventSchema],
  [EventType.TOOL_CALL_CHUNK, ToolCallChunkEventSchema],
  [EventType.RUN_FINISHED, RunFinishedEventSchema],
  [EventType.RUN_ERROR, RunErrorEventSchema],
  [EventType.STEP_STARTED, StepStartedEventSchema],
  [EventType.STEP_FINISHED, StepFinishedEventSchema],
  [EventType.REASONING_START, ReasoningStartEventSchema],
  [EventType.REASONING_MESSAGE_START, ReasoningMessageStartEventSchema],
  [EventType.REASONING_MESSAGE_CONTENT, ReasoningMessageContentEventSchema],
  [EventType.REASONING_MESSAGE_END, ReasoningMessageEndEventSchema],
  [EventType.REASONING_MESSAGE_CHUNK, ReasoningMessageChunkEventSchema],
  [EventType.REASONING_END, ReasoningEndEventSchema],
]);
const EVENT_FIELDS = new Map([
  [EventType.RUN_STARTED, ['type', 'timestamp', 'threadId', 'runId', 'parentRunId']],
  [EventType.TEXT_MESSAGE_START, ['type', 'timestamp', 'messageId', 'role', 'name']],
  [EventType.TEXT_MESSAGE_CONTENT, ['type', 'timestamp', 'messageId', 'delta']],
  [EventType.TEXT_MESSAGE_END, ['type', 'timestamp', 'messageId']],
  [EventType.TEXT_MESSAGE_CHUNK, ['type', 'timestamp', 'messageId', 'role', 'delta', 'name']],
  [EventType.TOOL_CALL_START, [
    'type', 'timestamp', 'toolCallId', 'toolCallName', 'parentMessageId',
  ]],
  [EventType.TOOL_CALL_ARGS, ['type', 'timestamp', 'toolCallId', 'delta']],
  [EventType.TOOL_CALL_END, ['type', 'timestamp', 'toolCallId']],
  [EventType.TOOL_CALL_CHUNK, [
    'type', 'timestamp', 'toolCallId', 'toolCallName', 'parentMessageId', 'delta',
  ]],
  [EventType.RUN_FINISHED, ['type', 'timestamp', 'threadId', 'runId', 'outcome', 'usage']],
  [EventType.RUN_ERROR, ['type', 'timestamp', 'message', 'code', 'usage']],
  [EventType.STEP_STARTED, ['type', 'timestamp', 'stepName']],
  [EventType.STEP_FINISHED, ['type', 'timestamp', 'stepName']],
  [EventType.REASONING_START, ['type', 'timestamp', 'messageId']],
  [EventType.REASONING_MESSAGE_START, ['type', 'timestamp', 'messageId', 'role']],
  [EventType.REASONING_MESSAGE_CONTENT, ['type', 'timestamp', 'messageId', 'delta']],
  [EventType.REASONING_MESSAGE_END, ['type', 'timestamp', 'messageId']],
  [EventType.REASONING_MESSAGE_CHUNK, ['type', 'timestamp', 'messageId', 'delta']],
  [EventType.REASONING_END, ['type', 'timestamp', 'messageId']],
]);

const fail = (message, code = 'bot_ag_ui_protocol_invalid', statusCode = 502, diagnostics = null) => {
  throw new BotReasoningAdapterError(message, code, statusCode, diagnostics);
};

const boundedId = (value, field) => {
  if (typeof value !== 'string' || value.length < 1
    || Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`AG-UI ${field} is invalid`);
  }
  return value;
};

const normalizeConnectionLimits = (value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !LIMIT_FIELDS.includes(key))) {
    fail('AG-UI connection limits are invalid', 'bot_agent_connection_invalid', 400);
  }
  const integer = (field, fallback, minimum, maximum) => {
    const candidate = value[field] ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      fail(`AG-UI connection limit ${field} is invalid`, 'bot_agent_connection_invalid', 400);
    }
    return candidate;
  };
  const maximumStreamBytes = integer('maximumStreamBytes', MAX_STREAM_BYTES, 1_024, MAX_STREAM_BYTES);
  const maximumTextBytes = integer('maximumTextBytes', MAX_TEXT_BYTES, 1_024, MAX_TEXT_BYTES);
  const maximumArgumentBytes = integer(
    'maximumArgumentBytes', MAX_ARGUMENT_BYTES, 1_024, MAX_ARGUMENT_BYTES,
  );
  if (maximumTextBytes > maximumStreamBytes || maximumArgumentBytes > maximumStreamBytes) {
    fail('AG-UI connection limits exceed the stream bound', 'bot_agent_connection_invalid', 400);
  }
  return Object.freeze({
    maximumStreamBytes,
    maximumTextBytes,
    maximumArgumentBytes,
    maximumEventCount: integer('maximumEventCount', MAX_EVENT_COUNT, 2, MAX_EVENT_COUNT),
    requestTimeoutMs: integer('requestTimeoutMs', 15 * 60 * 1_000, 1_000, 15 * 60 * 1_000),
    healthTimeoutMs: integer('healthTimeoutMs', 10_000, 1_000, 10_000),
  });
};

export const normalizeAgUiConnectionDescriptor = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('AG-UI connection descriptor is invalid', 'bot_agent_connection_invalid', 400);
  }
  const allowed = [
    'id', 'botId', 'endpointUrl', 'protocolVersion', 'authMode', 'credentialId',
    'modelHint', 'limits', 'descriptorDigest', 'status', 'revokedAt',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail('AG-UI connection descriptor contains an unknown field', 'bot_agent_connection_invalid', 400);
  }
  let endpoint;
  try {
    endpoint = new URL(value.endpointUrl);
  } catch {
    fail('AG-UI endpoint URL is invalid', 'bot_agent_connection_invalid', 400);
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash
    || !endpoint.hostname || endpoint.hostname === 'localhost'
    || endpoint.hostname.endsWith('.localhost') || endpoint.hostname.endsWith('.local')
    || endpoint.hostname.endsWith('.internal')) {
    fail('AG-UI endpoint must be an exact public HTTPS URL', 'bot_agent_connection_invalid', 400);
  }
  const protocolVersion = value.protocolVersion ?? AG_UI_PROTOCOL_VERSION;
  const authMode = value.authMode ?? 'none';
  const limits = normalizeConnectionLimits(value.limits ?? {});
  if (protocolVersion !== AG_UI_PROTOCOL_VERSION || !['none', 'bearer'].includes(authMode)
    || !limits || typeof limits !== 'object' || Array.isArray(limits)
    || (authMode === 'none' && value.credentialId)
    || (authMode === 'bearer' && !value.credentialId)
    || value.status === 'revoked' || value.revokedAt) {
    fail('AG-UI connection is unavailable', 'bot_agent_connection_unavailable', 409);
  }
  const portable = Object.freeze({
    endpointUrl: endpoint.href,
    protocolVersion,
    authMode,
    limits,
    modelHint: value.modelHint || null,
  });
  const descriptorDigest = hashCanonicalBotJson(portable);
  if (value.descriptorDigest && value.descriptorDigest !== descriptorDigest) {
    fail('AG-UI connection descriptor digest does not match', 'bot_agent_connection_digest_mismatch', 409);
  }
  return Object.freeze({
    id: value.id,
    botId: value.botId,
    endpointUrl: endpoint.href,
    protocolVersion,
    authMode,
    credentialId: value.credentialId || null,
    modelHint: value.modelHint || null,
    limits,
    descriptorDigest,
  });
};

const parseSseFrames = (source, limits) => {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > limits.maximumStreamBytes) {
    fail('AG-UI response exceeds the streaming bound', 'bot_ag_ui_response_too_large', 413);
  }
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const frames = normalized.split('\n\n');
  const ids = new Set();
  const payloads = [];
  for (const frame of frames) {
    if (!frame.trim()) continue;
    const data = [];
    let eventId = null;
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /u, ''));
      } else if (line.startsWith('id:')) {
        eventId = boundedId(line.slice(3).trim(), 'event ID');
      } else if (line.startsWith('event:')) {
        const eventName = line.slice(6).trim();
        if (eventName && eventName !== 'message') fail('AG-UI SSE event name is unsupported');
      } else {
        fail('AG-UI SSE field is unsupported');
      }
    }
    if (eventId !== null) {
      if (ids.has(eventId)) fail('AG-UI stream replayed an event ID', 'bot_ag_ui_event_replayed', 409);
      ids.add(eventId);
    }
    if (data.length !== 1 || data[0] === '[DONE]') {
      fail('AG-UI SSE frame must contain one JSON event');
    }
    payloads.push(data[0]);
    if (payloads.length > limits.maximumEventCount) {
      fail('AG-UI stream contains too many events', 'bot_ag_ui_response_too_large', 413);
    }
  }
  return payloads;
};

const parseEvent = (source, limits) => {
  let raw;
  try {
    raw = parseStrictJson(source, { maximumBytes: limits.maximumStreamBytes, maximumDepth: 16 });
  } catch (error) {
    fail('AG-UI event is not strict JSON', 'bot_ag_ui_event_invalid', 502, {
      parserCode: error?.code || null,
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.type !== 'string' || !ALLOWED_EVENT_TYPES.has(raw.type)) {
    fail('AG-UI event type is unsupported', 'bot_ag_ui_event_unsupported', 502);
  }
  const schema = EVENT_SCHEMAS.get(raw.type);
  const allowedFields = EVENT_FIELDS.get(raw.type);
  if (!schema || !allowedFields
    || Object.keys(raw).some((field) => !allowedFields.includes(field))) {
    fail('AG-UI event contains an unsupported field', 'bot_ag_ui_event_unsupported', 502);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail('AG-UI event shape is invalid', 'bot_ag_ui_event_invalid', 502);
  return parsed.data;
};

const normalizeToolArguments = (source, limits) => {
  let args;
  try {
    args = parseStrictJson(source, { maximumBytes: limits.maximumArgumentBytes, maximumDepth: 12 });
  } catch (error) {
    fail('AG-UI tool arguments are incomplete or invalid', 'bot_ag_ui_tool_arguments_invalid', 502, {
      parserCode: error?.code || null,
    });
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).sort().join('\0') !== 'operation\0payload'
    || typeof args.operation !== 'string'
    || !args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    fail('AG-UI devryan_bot arguments are invalid', 'bot_ag_ui_tool_arguments_invalid', 502);
  }
  return Object.freeze({ operation: args.operation, payload: Object.freeze(args.payload) });
};

export const parseAgUiEventStream = async ({
  source,
  expectedRunId,
  expectedThreadId,
  onEvent = async () => {},
  limits: inputLimits = {},
} = {}) => {
  if (typeof onEvent !== 'function') fail('AG-UI event sink is invalid');
  const limits = normalizeConnectionLimits(inputLimits);
  const state = {
    started: false,
    terminal: false,
    activeText: null,
    activeReasoning: null,
    reasoningRoot: null,
    activeStep: null,
    textBytes: 0,
    seenMessageIds: new Set(),
    seenReasoningIds: new Set(),
    tools: new Map(),
    completedToolIds: new Set(),
    toolIntents: [],
    sequence: 0,
    usage: [],
  };
  const emit = async (kind, payload = {}) => {
    state.sequence += 1;
    await onEvent(createBotReasoningEvent(kind, { sequence: state.sequence, ...payload }));
  };
  for (const frame of parseSseFrames(source, limits)) {
    const event = parseEvent(frame, limits);
    if (state.terminal) fail('AG-UI emitted data after a terminal event');
    if (!state.started && event.type !== EventType.RUN_STARTED) {
      fail('AG-UI stream did not begin with RUN_STARTED');
    }
    if (event.type === EventType.RUN_STARTED) {
      if (state.started || event.runId !== expectedRunId || event.threadId !== expectedThreadId) {
        fail('AG-UI RUN_STARTED does not match the invocation');
      }
      state.started = true;
      await emit('run.started', { runId: event.runId, threadId: event.threadId });
    } else if (event.type === EventType.TEXT_MESSAGE_START) {
      if (state.activeText || event.role !== 'assistant') fail('AG-UI text start ordering is invalid');
      const messageId = boundedId(event.messageId, 'message ID');
      if (state.seenMessageIds.has(messageId)) fail('AG-UI message ID is duplicated');
      state.seenMessageIds.add(messageId);
      state.activeText = messageId;
      await emit('assistant.message', { messageId, role: 'assistant', tokens: {} });
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      if (!state.activeText || event.messageId !== state.activeText || typeof event.delta !== 'string') {
        fail('AG-UI text content ordering is invalid');
      }
      state.textBytes += Buffer.byteLength(event.delta, 'utf8');
      if (state.textBytes > limits.maximumTextBytes) {
        fail('AG-UI assistant text exceeds the streaming bound', 'bot_ag_ui_response_too_large', 413);
      }
      await emit('assistant.text', {
        messageId: event.messageId,
        partId: `text:${event.messageId}`,
        text: event.delta,
        mode: 'append',
      });
    } else if (event.type === EventType.TEXT_MESSAGE_END) {
      if (!state.activeText || event.messageId !== state.activeText) {
        fail('AG-UI text end ordering is invalid');
      }
      state.activeText = null;
    } else if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
      if (state.activeText || typeof event.delta !== 'string') {
        fail('AG-UI text chunk ordering is invalid');
      }
      const messageId = boundedId(event.messageId, 'message ID');
      if (state.seenMessageIds.has(messageId)) fail('AG-UI message ID is duplicated');
      state.seenMessageIds.add(messageId);
      state.textBytes += Buffer.byteLength(event.delta, 'utf8');
      if (state.textBytes > limits.maximumTextBytes) {
        fail('AG-UI assistant text exceeds the streaming bound', 'bot_ag_ui_response_too_large', 413);
      }
      await emit('assistant.message', { messageId, role: 'assistant', tokens: {} });
      await emit('assistant.text', {
        messageId,
        partId: `text:${messageId}`,
        text: event.delta,
        mode: 'append',
      });
    } else if (event.type === EventType.TOOL_CALL_START) {
      const toolCallId = boundedId(event.toolCallId, 'tool call ID');
      if (event.toolCallName !== 'devryan_bot' || state.tools.has(toolCallId)
        || state.tools.size > 0 || state.completedToolIds.size > 0) {
        fail('AG-UI tool call is unknown or duplicated', 'bot_ag_ui_tool_rejected', 502);
      }
      state.tools.set(toolCallId, { args: '', parentMessageId: event.parentMessageId || null });
    } else if (event.type === EventType.TOOL_CALL_ARGS) {
      const tool = state.tools.get(event.toolCallId);
      if (!tool || typeof event.delta !== 'string') fail('AG-UI tool argument ordering is invalid');
      tool.args += event.delta;
      if (Buffer.byteLength(tool.args, 'utf8') > limits.maximumArgumentBytes) {
        fail('AG-UI tool arguments exceed the bound', 'bot_ag_ui_response_too_large', 413);
      }
    } else if (event.type === EventType.TOOL_CALL_CHUNK) {
      if (!event.toolCallId || event.toolCallName !== 'devryan_bot'
        || typeof event.delta !== 'string' || state.completedToolIds.has(event.toolCallId)
        || (!state.tools.has(event.toolCallId)
          && (state.tools.size > 0 || state.completedToolIds.size > 0))) {
        fail('AG-UI tool chunk is invalid', 'bot_ag_ui_tool_rejected', 502);
      }
      const tool = state.tools.get(event.toolCallId) || {
        args: '', parentMessageId: event.parentMessageId || null,
      };
      tool.args += event.delta;
      if (Buffer.byteLength(tool.args, 'utf8') > limits.maximumArgumentBytes) {
        fail('AG-UI tool arguments exceed the bound', 'bot_ag_ui_response_too_large', 413);
      }
      state.tools.set(event.toolCallId, tool);
    } else if (event.type === EventType.TOOL_CALL_END) {
      const tool = state.tools.get(event.toolCallId);
      if (!tool) fail('AG-UI tool end ordering is invalid');
      const intent = Object.freeze({
        toolCallId: event.toolCallId,
        parentMessageId: tool.parentMessageId,
        ...normalizeToolArguments(tool.args, limits),
      });
      state.tools.delete(event.toolCallId);
      state.completedToolIds.add(event.toolCallId);
      state.toolIntents.push(intent);
      await emit('governed_tool.intent', intent);
    } else if (event.type === EventType.RUN_FINISHED) {
      if (event.runId !== expectedRunId || event.threadId !== expectedThreadId
        || state.activeText || state.activeReasoning || state.reasoningRoot
        || state.activeStep || state.tools.size > 0) {
        fail('AG-UI run finished with incomplete or mismatched output');
      }
      if (event.outcome && event.outcome.type && event.outcome.type !== 'success') {
        fail('AG-UI interrupts are unsupported', 'bot_ag_ui_interrupt_unsupported', 409);
      }
      state.terminal = true;
      state.usage = Array.isArray(event.usage) ? event.usage : [];
      if (state.usage.length > 0) await emit('usage', { entries: state.usage });
      await emit('run.completed', { needsToolContinuation: state.toolIntents.length > 0 });
    } else if (event.type === EventType.RUN_ERROR) {
      if (state.activeText || state.activeReasoning || state.reasoningRoot
        || state.activeStep || state.tools.size > 0) {
        fail('AG-UI run failed with incomplete output');
      }
      state.terminal = true;
      await emit('run.error', {
        code: typeof event.code === 'string' ? event.code.slice(0, 120) : 'bot_ag_ui_run_error',
        retryable: false,
      });
    } else if (event.type === EventType.REASONING_START) {
      const messageId = boundedId(event.messageId, 'reasoning ID');
      if (state.reasoningRoot || state.activeReasoning || state.seenReasoningIds.has(messageId)) {
        fail('AG-UI reasoning start ordering is invalid');
      }
      state.reasoningRoot = messageId;
      state.seenReasoningIds.add(messageId);
      await emit('checkpoint', { kind: 'reasoning', visible: false });
    } else if (event.type === EventType.REASONING_MESSAGE_START) {
      const messageId = boundedId(event.messageId, 'reasoning message ID');
      if (!state.reasoningRoot || state.activeReasoning || event.role !== 'reasoning'
        || state.seenReasoningIds.has(messageId)) {
        fail('AG-UI reasoning message start ordering is invalid');
      }
      state.activeReasoning = messageId;
      state.seenReasoningIds.add(messageId);
      await emit('checkpoint', { kind: 'reasoning', visible: false });
    } else if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
      if (!state.activeReasoning || event.messageId !== state.activeReasoning
        || typeof event.delta !== 'string'
        || Buffer.byteLength(event.delta, 'utf8') > limits.maximumTextBytes) {
        fail('AG-UI reasoning event is invalid');
      }
      await emit('checkpoint', { kind: 'reasoning', visible: false });
    } else if (event.type === EventType.REASONING_MESSAGE_END) {
      if (!state.activeReasoning || event.messageId !== state.activeReasoning) {
        fail('AG-UI reasoning message end ordering is invalid');
      }
      state.activeReasoning = null;
      await emit('checkpoint', { kind: 'reasoning', visible: false });
    } else if (event.type === EventType.REASONING_MESSAGE_CHUNK) {
      const messageId = boundedId(event.messageId, 'reasoning message ID');
      if (!state.reasoningRoot || state.activeReasoning || state.seenReasoningIds.has(messageId)
        || typeof event.delta !== 'string'
        || Buffer.byteLength(event.delta, 'utf8') > limits.maximumTextBytes) {
        fail('AG-UI reasoning chunk ordering is invalid');
      }
      state.seenReasoningIds.add(messageId);
      await emit('checkpoint', { kind: 'reasoning', visible: false });
    } else if (event.type === EventType.REASONING_END) {
      if (!state.reasoningRoot || state.activeReasoning || event.messageId !== state.reasoningRoot) {
        fail('AG-UI reasoning end ordering is invalid');
      }
      state.reasoningRoot = null;
      await emit('checkpoint', { kind: 'reasoning', visible: false });
    } else if (event.type === EventType.STEP_STARTED) {
      const stepName = boundedId(event.stepName, 'step name');
      if (state.activeStep) fail('AG-UI step start ordering is invalid');
      state.activeStep = stepName;
      await emit('checkpoint', { kind: 'lifecycle', visible: false });
    } else if (event.type === EventType.STEP_FINISHED) {
      if (!state.activeStep || event.stepName !== state.activeStep) {
        fail('AG-UI step finish ordering is invalid');
      }
      state.activeStep = null;
      await emit('checkpoint', { kind: 'lifecycle', visible: false });
    }
  }
  if (!state.started || !state.terminal) fail('AG-UI stream ended before the run settled');
  if (state.toolIntents.length > 1) {
    fail('AG-UI v1 accepts one governed tool continuation per invocation', 'bot_ag_ui_tool_rejected', 502);
  }
  return Object.freeze({
    status: state.toolIntents.length === 1 ? 'tool' : 'completed',
    toolIntent: state.toolIntents[0] || null,
    eventSequence: state.sequence,
    usage: Object.freeze(state.usage.map((entry) => Object.freeze({ ...entry }))),
  });
};

const inputMessagesFromParts = (parts, messageId) => {
  if (!Array.isArray(parts)) fail('AG-UI prompt parts are invalid', 'bot_ag_ui_input_invalid', 400);
  const text = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n');
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_STREAM_BYTES) {
    fail('AG-UI prompt text is invalid', 'bot_ag_ui_input_invalid', 400);
  }
  return [Object.freeze({ id: messageId, role: 'user', content: text })];
};

const DEVRYAN_TOOL = Object.freeze({
  name: 'devryan_bot',
  description: 'Submit one governed DevRyan operation. Every operation is evaluated, approved when required, receipted, and reconciled by DevRyan.',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['operation', 'payload']),
    properties: Object.freeze({
      operation: Object.freeze({ type: 'string' }),
      payload: Object.freeze({ type: 'object' }),
    }),
  }),
});

export function createAgUiReasoningAdapter({
  resolveConnection,
  resolveBearer = async () => null,
  request,
  uuid = randomUUID,
  timeoutMs = 15 * 60 * 1_000,
} = {}) {
  if (typeof resolveConnection !== 'function' || typeof resolveBearer !== 'function'
    || typeof request !== 'function' || typeof uuid !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1_000) {
    throw new TypeError('AG-UI reasoning adapter is misconfigured');
  }
  const loadConnection = async (binding) => {
    const connection = normalizeAgUiConnectionDescriptor(await resolveConnection(binding.connectionRef));
    if (connection.descriptorDigest !== binding.connectionDigest) {
      fail('AG-UI revision binding no longer matches the connection', 'bot_agent_connection_digest_mismatch', 409);
    }
    return connection;
  };
  const invoke = async ({ connection, binding, input, signal }) => {
    const parsedInput = RunAgentInputSchema.safeParse(input);
    if (!parsedInput.success || parsedInput.data.tools.length !== 1
      || parsedInput.data.tools[0].name !== 'devryan_bot') {
      fail('AG-UI RunAgentInput is invalid', 'bot_ag_ui_input_invalid', 400);
    }
    let bearer = null;
    try {
      bearer = connection.authMode === 'bearer'
        ? await resolveBearer(connection.credentialId)
        : null;
      if (connection.authMode === 'bearer'
        && (typeof bearer !== 'string' || bearer.length < 1 || bearer.length > 8_192)) {
        fail('AG-UI bearer credential is unavailable', 'bot_agent_connection_credential_unavailable', 409);
      }
      const response = await request({
        url: connection.endpointUrl,
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: `${canonicalizeBotJson(parsedInput.data)}\n`,
        redirect: 'manual',
        signal: signal || AbortSignal.timeout(Math.min(timeoutMs, connection.limits.requestTimeoutMs)),
        maximumBytes: connection.limits.maximumStreamBytes,
        purpose: 'agent',
        botId: binding.botId || connection.botId,
        revisionId: binding.revisionId || null,
        hosts: [new URL(connection.endpointUrl).host],
      });
      if (!response || response.status < 200 || response.status > 299
        || response.redirected === true || (response.status >= 300 && response.status < 400)) {
        fail('AG-UI endpoint rejected the invocation', 'bot_ag_ui_endpoint_failed', 502);
      }
      const contentType = response.headers?.['content-type'] || response.headers?.get?.('content-type');
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('text/event-stream')) {
        fail('AG-UI endpoint did not return SSE', 'bot_ag_ui_content_type_invalid', 502);
      }
      return typeof response.body === 'string'
        ? response.body
        : Buffer.from(response.body || []).toString('utf8');
    } finally {
      bearer = null;
    }
  };

  return Object.freeze({
    kind: 'ag_ui',
    async health({ binding }) {
      const connection = await loadConnection(binding);
      let bearer = null;
      try {
        bearer = connection.authMode === 'bearer'
          ? await resolveBearer(connection.credentialId)
          : null;
        const response = await request({
          url: connection.endpointUrl,
          method: 'HEAD',
          headers: {
            accept: 'text/event-stream',
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          redirect: 'manual',
          body: '',
          signal: AbortSignal.timeout(Math.min(timeoutMs, connection.limits.healthTimeoutMs)),
          maximumBytes: 0,
          purpose: 'agent',
          botId: binding.botId || connection.botId,
          revisionId: binding.revisionId || null,
          hosts: [new URL(connection.endpointUrl).host],
        });
        return Object.freeze({
          ok: Boolean(response && response.status >= 200 && response.status < 300
            && response.redirected !== true),
          adapter: 'ag_ui',
          descriptorDigest: connection.descriptorDigest,
        });
      } finally {
        bearer = null;
      }
    },
    async prepareRevision({ binding }) {
      const connection = await loadConnection(binding);
      return Object.freeze({
        modelSnapshot: Object.freeze({
          providerId: 'ag_ui',
          modelId: binding.modelHint || connection.modelHint || 'endpoint-selected',
        }),
        prepared: Object.freeze({ connection }),
      });
    },
    async startRun({ runId, execution = null, continuation = null }) {
      const effectiveExecution = execution || (continuation?.create === false
        ? continuation.execution
        : null);
      const threadId = effectiveExecution?.threadId || uuid();
      return Object.freeze({
        threadId,
        execution: Object.freeze({
          version: 1,
          adapter: 'ag_ui',
          threadId,
          invocationId: effectiveExecution?.invocationId || null,
          eventSequence: Number(effectiveExecution?.eventSequence) || 0,
          continuationParent: effectiveExecution?.continuationParent || null,
          pendingToolCall: effectiveExecution?.pendingToolCall || null,
          checkpointVersion: Number(effectiveExecution?.checkpointVersion) || 1,
          messages: Object.freeze(structuredClone(effectiveExecution?.messages || [])),
        }),
      });
    },
    async continueRun({ runId, handle, binding, parts = null, toolMessage = null, onEvent, signal }) {
      const connection = await loadConnection(binding);
      const invocationId = uuid();
      const priorMessages = [...(handle.execution?.messages || [])];
      if (parts) priorMessages.push(...inputMessagesFromParts(parts, uuid()));
      if (toolMessage) {
        priorMessages.push(Object.freeze({
          id: uuid(),
          role: 'tool',
          toolCallId: boundedId(toolMessage.toolCallId, 'tool call ID'),
          content: typeof toolMessage.content === 'string'
            ? toolMessage.content.slice(0, MAX_STREAM_BYTES)
            : canonicalizeBotJson(toolMessage.content),
          ...(toolMessage.error ? { error: String(toolMessage.error).slice(0, 512) } : {}),
        }));
      }
      const input = {
        threadId: handle.threadId,
        runId: invocationId,
        ...(handle.execution?.invocationId
          ? { parentRunId: handle.execution.invocationId }
          : {}),
        state: {},
        messages: priorMessages,
        tools: [DEVRYAN_TOOL],
        context: [],
        forwardedProps: {},
      };
      const parsed = await parseAgUiEventStream({
        source: await invoke({ connection, binding, input, signal }),
        expectedRunId: invocationId,
        expectedThreadId: handle.threadId,
        onEvent,
        limits: connection.limits,
      });
      if (parsed.toolIntent) {
        priorMessages.push(Object.freeze({
          id: parsed.toolIntent.parentMessageId || uuid(),
          role: 'assistant',
          content: '',
          toolCalls: Object.freeze([Object.freeze({
            id: parsed.toolIntent.toolCallId,
            type: 'function',
            function: Object.freeze({
              name: 'devryan_bot',
              arguments: canonicalizeBotJson({
                operation: parsed.toolIntent.operation,
                payload: parsed.toolIntent.payload,
              }),
            }),
          })]),
        }));
      }
      const execution = Object.freeze({
        ...handle.execution,
        invocationId,
        eventSequence: (Number(handle.execution?.eventSequence) || 0) + parsed.eventSequence,
        continuationParent: handle.execution?.invocationId || null,
        pendingToolCall: parsed.toolIntent,
        messages: Object.freeze(priorMessages),
      });
      return Object.freeze({ ...parsed, handle: Object.freeze({ ...handle, execution }) });
    },
    async inspectRun({ handle }) {
      if (!handle?.execution?.invocationId) {
        return Object.freeze({ status: 'not_started', resumable: true, handle });
      }
      return Object.freeze({
        status: handle.execution.pendingToolCall ? 'interrupted' : 'unknown',
        resumable: false,
        retryAsNewRequired: true,
        handle,
      });
    },
    async cancelRun() {
      // v1 does not delegate cancellation authority to the endpoint. Aborting
      // the host request is the only safe local cancellation mechanism.
      return Object.freeze({ cancelled: true, remoteState: 'unknown' });
    },
    async closeRun() {
      return Object.freeze({ closed: true });
    },
    async completeStructured({ binding, prompt, schema, title = 'Structured task', system = '' }) {
      const handle = await this.startRun({ runId: uuid() });
      let text = '';
      const result = await this.continueRun({
        runId: uuid(),
        handle,
        binding,
        parts: [{
          type: 'text',
          text: `${system}\n\n${title}\n\n${prompt}\n\nReturn only JSON matching this schema:\n${canonicalizeBotJson(schema)}`,
        }],
        onEvent: async (event) => {
          if (event.kind === 'governed_tool.intent') {
            fail('AG-UI structured completion attempted a tool call', 'bot_ag_ui_tool_rejected', 502);
          }
          if (event.kind === 'assistant.text') text += event.payload.text;
        },
      });
      if (result.status !== 'completed') fail('AG-UI structured completion did not settle');
      return parseStrictJson(text, { maximumBytes: MAX_STREAM_BYTES, maximumDepth: 16 });
    },
  });
}

export const AG_UI_CONNECTION_PROTOCOL_VERSION = AG_UI_PROTOCOL_VERSION;
export const AG_UI_CONNECTION_DESCRIPTOR_DIGEST = (descriptor) => (
  normalizeAgUiConnectionDescriptor(descriptor).descriptorDigest
);
export const AG_UI_ENDPOINT_HOST_DIGEST = (endpointUrl) => (
  crypto.createHash('sha256').update(new URL(endpointUrl).host, 'utf8').digest('hex')
);
