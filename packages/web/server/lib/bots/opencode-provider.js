import { setTimeout as delay } from 'node:timers/promises';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { classifyProviderTransportFailure } from '@openchamber/orchestration-runtime';

import { BOT_GATEWAY_OPERATIONS } from './gateway-host.js';
import {
  isPublicBotAssistantTextPart,
  sanitizeBotConversationalText,
} from './response-sanitizer.js';
import { assertExactObject, validateBoundedJsonObject, validateBoundedString, validateUuid } from './validation.js';

const WORKSPACE_DIRECTORY = '/workspace';
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const ATTACHMENT_DELIVERY_MODES = new Set(['auto', 'compatibility']);

const defaultSubscribeToEvents = async ({ client, signal, onEvent }) => {
  if (typeof client?.event?.subscribe !== 'function') return;
  const result = await client.event.subscribe(
    { directory: WORKSPACE_DIRECTORY },
    {
      signal,
      sseMaxRetryAttempts: 0,
      onSseEvent: (event) => onEvent(event?.data),
    },
  );
  for await (const _ of result.stream) {
    void _;
    if (signal.aborted) break;
  }
};

export class BotOpenCodeProviderError extends Error {
  constructor(message, code = 'bot_opencode_unavailable', statusCode = 503) {
    super(message);
    this.name = 'BotOpenCodeProviderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotOpenCodeProviderError(message, code, statusCode);
};

const safeUpstreamErrorName = (error) => {
  const candidate = error && typeof error === 'object'
    ? (error.name || error.code || error.data?.name || error.data?.code)
    : null;
  return typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(candidate)
    ? candidate
    : null;
};

const safeUpstreamFailureClass = (error) => {
  const name = typeof error?.name === 'string' ? error.name : '';
  const message = typeof error?.data?.message === 'string' ? error.data.message : '';
  const transport = classifyProviderTransportFailure(name, message);
  if (transport) return transport;
  const combined = `${name} ${message}`;
  if (/(?:auth|oauth|access token|refresh token|credential|invalid api key)/i.test(combined)) {
    return 'provider_authentication';
  }
  if (/(?:modelnotfound|model (?:is )?not found|unknown model|invalid model)/i.test(combined)) {
    return 'model_unavailable';
  }
  if (/(?:certificate|self signed|x509|unable to verify)/i.test(combined)) return 'tls_failure';
  if (/(?:proxy authentication|proxy.*407)/i.test(combined)) return 'proxy_authentication';
  if (/(?:rate limit|quota|out of usage|usage limit)/i.test(combined)) return 'usage_limit';
  return null;
};

const unwrap = (result, operation, { allowEmpty = false, logger = null } = {}) => {
  if (result?.error) {
    logger?.warn?.('[BotsOpenCode] scoped request rejected', {
      operation,
      statusCode: Number.isInteger(result.response?.status) ? result.response.status : null,
      upstreamError: safeUpstreamErrorName(result.error),
      failureClass: safeUpstreamFailureClass(result.error),
    });
    fail(`${operation} failed`, 'bot_opencode_request_failed', 502);
  }
  if (!allowEmpty && (result?.data === undefined || result?.data === null)) {
    fail(`${operation} returned no data`, 'bot_opencode_response_invalid', 502);
  }
  return result?.data;
};

const defaultWaitForReady = async ({ endpoint, fetchImpl, timeoutMs = DEFAULT_READY_TIMEOUT_MS }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${endpoint}/global/health`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
    }
    await delay(200);
  }
  fail('Scoped OpenCode runtime did not become ready', 'bot_opencode_start_timeout', 504);
};

const normalizeStartInput = (input) => {
  try {
    assertExactObject(input, {
      label: 'Bot OpenCode start request',
      required: ['run', 'contract', 'catalog'],
      optional: ['attachmentIds', 'libraryVersionIds', 'attachmentDeliveryMode', 'compiled'],
    });
  } catch (error) {
    fail(error.message, 'bot_opencode_request_invalid', 400);
  }
  if (!input.run || typeof input.run !== 'object' || Array.isArray(input.run)) {
    fail('Bot OpenCode run is invalid', 'bot_opencode_request_invalid', 400);
  }
  const attachmentDeliveryMode = input.attachmentDeliveryMode ?? 'auto';
  if (!ATTACHMENT_DELIVERY_MODES.has(attachmentDeliveryMode)) {
    fail('Bot attachment delivery mode is invalid', 'bot_opencode_request_invalid', 400);
  }
  if (input.compiled !== undefined
    && (!input.compiled || typeof input.compiled !== 'object'
      || typeof input.compiled.compiledHash !== 'string'
      || !input.compiled.contract || typeof input.compiled.contract !== 'object')) {
    fail('Bot prewarmed config is invalid', 'bot_opencode_request_invalid', 400);
  }
  return { ...input, attachmentDeliveryMode };
};

const normalizeSessionTitle = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 160) {
    fail('Bot OpenCode session title is invalid', 'bot_opencode_request_invalid', 400);
  }
  return normalized;
};

const normalizeParts = (parts) => {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 128) {
    fail('Bot OpenCode prompt parts are invalid', 'bot_opencode_request_invalid', 400);
  }
  const encoded = JSON.stringify(parts);
  if (Buffer.byteLength(encoded, 'utf8') > 2 * 1024 * 1024) {
    fail('Bot OpenCode prompt parts are too large', 'bot_opencode_request_invalid', 413);
  }
  return JSON.parse(encoded);
};

const taggedJson = (value) => JSON.stringify(value)
  .replaceAll('&', '\\u0026')
  .replaceAll('<', '\\u003c')
  .replaceAll('>', '\\u003e');

export const botRunMarker = (runId) => (
  `<devryan_bot_run id="${validateUuid(runId, 'runId')}" />`
);

const partsWithRunMarker = (parts, runId) => {
  const normalized = normalizeParts(parts);
  const textIndex = normalized.findIndex((part) => (
    part?.type === 'text' && typeof part.text === 'string'
  ));
  if (textIndex < 0) {
    fail('Bot OpenCode prompt requires a text part', 'bot_opencode_request_invalid', 400);
  }
  normalized[textIndex] = {
    ...normalized[textIndex],
    text: `${botRunMarker(runId)}\n${normalized[textIndex].text}`,
  };
  return normalized;
};

const normalizeSessionId = (value) => {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId || sessionId.length > 256) {
    fail('Bot OpenCode session ID is invalid', 'bot_opencode_request_invalid', 400);
  }
  return sessionId;
};

const normalizeStructuredSchema = (value) => {
  try {
    return validateBoundedJsonObject(value, 'Bot structured-output schema', 128 * 1024);
  } catch (error) {
    fail(error.message, 'bot_opencode_request_invalid', error.statusCode || 400);
  }
};

const recordText = (record) => (Array.isArray(record?.parts) ? record.parts : [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('');

const SUCCESSFUL_TOOL_STATUSES = new Set(['completed', 'complete', 'done']);

const generatedImageDescriptor = (part, index) => {
  if (part?.type !== 'tool' || part.tool !== 'devryan_bot') return null;
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  const status = typeof state.status === 'string' ? state.status.trim().toLowerCase() : '';
  if (!SUCCESSFUL_TOOL_STATUSES.has(status)) return null;
  if (state.input?.operation !== 'image.generate') return null;
  const output = typeof state.metadata?.out === 'string' ? state.metadata.out.trim() : '';
  const relative = output.startsWith('/workspace/') ? output.slice('/workspace/'.length) : output;
  if (!relative || relative.startsWith('/') || relative.includes('\0') || relative.includes('\\')
    || Buffer.byteLength(relative, 'utf8') > 1024) return null;
  const segments = relative.split('/');
  if (segments.length > 32 || segments.some((segment) => (
    segment === '' || segment === '.' || segment === '..'
    || Buffer.byteLength(segment, 'utf8') > 255
  )) || ['.devryan', '.opencode'].includes(segments[0].toLowerCase())) return null;
  const toolPartId = typeof part.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(part.id)
    ? part.id
    : `tool-${index}`;
  return Object.freeze({ toolPartId, sourcePath: segments.join('/') });
};

const generatedImageDescriptors = (parts) => {
  const found = new Map();
  for (const [index, part] of parts.entries()) {
    const descriptor = generatedImageDescriptor(part, index);
    if (descriptor && !found.has(descriptor.sourcePath) && found.size < 12) {
      found.set(descriptor.sourcePath, descriptor);
    }
  }
  return Object.freeze([...found.values()]);
};

export const projectBotAssistantResponse = (parts) => {
  const ordered = Array.isArray(parts) ? parts : [];
  const firstToolIndex = ordered.findIndex((part) => part?.type === 'tool');
  const joinPublicText = (values) => sanitizeBotConversationalText(values
    .filter(isPublicBotAssistantTextPart)
    .map((part) => part.text)
    .join(''));
  if (firstToolIndex < 0) {
    return Object.freeze({
      toolObserved: false,
      acknowledgmentText: '',
      resultText: joinPublicText(ordered),
      generatedImages: generatedImageDescriptors(ordered),
    });
  }
  let lastToolIndex = firstToolIndex;
  for (let index = firstToolIndex + 1; index < ordered.length; index += 1) {
    if (ordered[index]?.type === 'tool') lastToolIndex = index;
  }
  return Object.freeze({
    toolObserved: true,
    acknowledgmentText: joinPublicText(ordered.slice(0, firstToolIndex)),
    resultText: joinPublicText(ordered.slice(lastToolIndex + 1)),
    generatedImages: generatedImageDescriptors(ordered),
  });
};

const isTerminalAssistantRecord = (record) => {
  if (record?.info?.role !== 'assistant') return false;
  if (typeof record.info.finish === 'string' && record.info.finish.trim()) return true;
  const completed = Number(record.info.time?.completed);
  return Number.isFinite(completed) && completed > 0;
};

const tokenTotal = (tokens) => {
  if (!tokens || typeof tokens !== 'object') return 0;
  return ['input', 'output', 'reasoning'].reduce((sum, key) => (
    sum + Math.max(0, Number(tokens[key]) || 0)
  ), 0) + Math.max(0, Number(tokens.cache?.read) || 0)
    + Math.max(0, Number(tokens.cache?.write) || 0);
};

const latestRecord = (records) => records.reduce((latest, record) => {
  if (!latest) return record;
  const latestTime = Number(latest.info?.time?.created || latest.info?.time?.completed || 0);
  const recordTime = Number(record.info?.time?.created || record.info?.time?.completed || 0);
  return recordTime >= latestTime ? record : latest;
}, null);

const exactMethodInput = (input, label, required, optional = []) => {
  try {
    return assertExactObject(input, { label, required, optional });
  } catch (error) {
    fail(error.message, 'bot_opencode_request_invalid', 400);
  }
};

export function createBotOpenCodeProvider({
  dockerProvider,
  configCompiler,
  modelCredentialBroker,
  gatewayHost,
  artifactService,
  environmentSecrets,
  createClient = createOpencodeClient,
  fetchImpl = fetch,
  waitForReady = defaultWaitForReady,
  subscribeToEvents = defaultSubscribeToEvents,
  logger = console,
} = {}) {
  if (!dockerProvider || typeof dockerProvider.ensureReasoning !== 'function'
    || typeof dockerProvider.stopReasoning !== 'function'
    || !configCompiler || typeof configCompiler.compile !== 'function'
    || !modelCredentialBroker || typeof modelCredentialBroker.prepareRun !== 'function'
    || typeof modelCredentialBroker.preflightRun !== 'function'
    || typeof modelCredentialBroker.finalizeRun !== 'function'
    || typeof modelCredentialBroker.discardRun !== 'function'
    || !gatewayHost || typeof gatewayHost.start !== 'function'
    || typeof gatewayHost.issueCapability !== 'function'
    || typeof gatewayHost.revokeRun !== 'function'
    || typeof gatewayHost.shutdown !== 'function'
    || !artifactService || typeof artifactService.materializeRun !== 'function'
    || typeof artifactService.cleanupRun !== 'function'
    || !environmentSecrets || typeof environmentSecrets.prepareRun !== 'function'
    || typeof environmentSecrets.finalizeRun !== 'function'
    || typeof createClient !== 'function' || typeof fetchImpl !== 'function'
    || typeof waitForReady !== 'function' || typeof subscribeToEvents !== 'function') {
    fail('Bot OpenCode provider is misconfigured', 'bot_opencode_configuration_invalid', 500);
  }
  const activeRuns = new Map();
  let started = false;
  let shutdownStarted = false;
  let eventHandler = null;

  const requireActive = (runId) => {
    const normalizedRunId = validateUuid(runId, 'runId');
    const active = activeRuns.get(normalizedRunId);
    if (!active) fail('Bot OpenCode run is not active', 'bot_opencode_run_not_found', 404);
    return active;
  };

  const stopActive = async (active) => {
    active.eventController?.abort();
    try {
      await dockerProvider.stopReasoning({
        botId: active.botId,
        channelId: active.channelId,
      });
    } catch (error) {
      gatewayHost.revokeRun(active.runId);
      await artifactService.cleanupRun(active.runId).catch(() => undefined);
      await environmentSecrets.finalizeRun(active.runId).catch(() => undefined);
      throw error;
    }
    gatewayHost.revokeRun(active.runId);
    activeRuns.delete(active.runId);
    await artifactService.cleanupRun(active.runId);
    await modelCredentialBroker.finalizeRun(active.runId);
    await environmentSecrets.finalizeRun(active.runId);
  };

  const startGateway = async () => {
    if (shutdownStarted) fail('Bot OpenCode provider has shut down', 'bot_opencode_shutdown', 503);
    if (started) return;
    await gatewayHost.start();
    started = true;
  };

  const runNoToolsStructured = async (input = {}) => {
    exactMethodInput(
      input,
      'Bot no-tools structured request',
      ['runId', 'prompt', 'schema'],
      ['title', 'system'],
    );
    const active = requireActive(input.runId);
    const prompt = validateBoundedString(input.prompt, 'Bot structured-output prompt', {
      maximum: 256 * 1024,
    });
    const schema = normalizeStructuredSchema(input.schema);
    const title = normalizeSessionTitle(
      input.title || `Bot structured output ${active.runId.slice(0, 8)}`,
    );
    const system = validateBoundedString(
      input.system || 'Return structured JSON only. Do not call tools or perform actions.',
      'Bot structured-output system prompt',
      { maximum: 16 * 1024 },
    );
    const created = unwrap(await active.client.session.create({
      directory: WORKSPACE_DIRECTORY,
      title,
    }), 'Bot structured-output session creation', { logger });
    const sessionId = normalizeSessionId(created?.id);
    try {
      if (typeof active.client.session?.prompt !== 'function') {
        fail('Bot structured output is unavailable', 'bot_opencode_structured_unavailable', 502);
      }
      const response = unwrap(await active.client.session.prompt({
        sessionID: sessionId,
        directory: WORKSPACE_DIRECTORY,
        agent: 'bot',
        model: {
          providerID: active.model.providerId,
          modelID: active.model.modelId,
        },
        ...(active.model.variant ? { variant: active.model.variant } : {}),
        tools: { '*': false },
        format: { type: 'json_schema', schema, retryCount: 2 },
        system,
        parts: [{ type: 'text', text: prompt }],
      }), 'Bot structured output', { logger });
      const output = recordText(response);
      if (!output || Buffer.byteLength(output, 'utf8') > 128 * 1024) {
        fail('Bot structured output returned invalid output', 'bot_opencode_response_invalid', 502);
      }
      return output;
    } finally {
      if (typeof active.client.session?.delete === 'function') {
        await active.client.session.delete({
          sessionID: sessionId,
          directory: WORKSPACE_DIRECTORY,
        }).catch(() => undefined);
      }
    }
  };

  return Object.freeze({
    start: startGateway,

    async preflightReasoningRun(input) {
      if (shutdownStarted) fail('Bot OpenCode provider is shutting down', 'bot_opencode_shutdown', 503);
      const normalized = normalizeStartInput(input);
      const compiled = normalized.compiled || await configCompiler.compile({
        channelId: normalized.run.channelId,
        revisionId: normalized.run.revisionId,
        contract: normalized.contract,
      });
      const checked = await modelCredentialBroker.preflightRun({
        run: normalized.run,
        models: compiled.contract.models,
        catalog: normalized.catalog,
      });
      return Object.freeze({
        compiledHash: compiled.compiledHash,
        model: checked.model,
        modelSnapshot: checked.modelSnapshot,
        egressHosts: checked.egressHosts,
      });
    },

    setEventHandler(handler) {
      if (handler !== null && typeof handler !== 'function') {
        throw new TypeError('Bot OpenCode event handler must be a function or null');
      }
      eventHandler = handler;
    },

    async startReasoningRun(input) {
      if (shutdownStarted) fail('Bot OpenCode provider is shutting down', 'bot_opencode_shutdown', 503);
      const normalized = normalizeStartInput(input);
      const runId = validateUuid(normalized.run.id, 'run.id');
      if (activeRuns.has(runId)) return activeRuns.get(runId).publicRuntime;
      await startGateway();
      const compiled = normalized.compiled || await configCompiler.compile({
        channelId: normalized.run.channelId,
        revisionId: normalized.run.revisionId,
        contract: normalized.contract,
      });
      const prepared = await modelCredentialBroker.prepareRun({
        run: normalized.run,
        models: compiled.contract.models,
        catalog: normalized.catalog,
      });
      const capability = gatewayHost.issueCapability({
        botId: normalized.run.botId,
        runId,
        channelId: normalized.run.channelId,
        revisionId: normalized.run.revisionId,
        scopeKey: `channel:${normalized.run.channelId}`,
        kind: 'reasoning',
        operations: BOT_GATEWAY_OPERATIONS,
      });
      let ensured;
      let materialized;
      let environment;
      try {
        environment = await environmentSecrets.prepareRun(normalized.run);
        materialized = await artifactService.materializeRun({
          run: normalized.run,
          channel: { id: normalized.run.channelId },
          attachmentIds: normalized.attachmentIds || [],
          libraryVersionIds: normalized.libraryVersionIds || [],
        });
        ensured = await dockerProvider.ensureReasoning({
          botId: normalized.run.botId,
          runId,
          channelId: normalized.run.channelId,
          revisionId: normalized.run.revisionId,
          runtimeToken: capability.token,
          compiledHash: compiled.compiledHash,
          gatewayUrl: capability.dockerGatewayUrl,
          egressHosts: prepared.egressHosts,
          environmentSecretCount: environment.count,
          chatgptImageGeneration: prepared.chatgptImageGeneration === true,
        });
        await waitForReady({ endpoint: ensured.endpoint.baseUrl, fetchImpl });
      } catch (error) {
        if (ensured) {
          await dockerProvider.stopReasoning({
            botId: normalized.run.botId,
            channelId: normalized.run.channelId,
          }).catch(() => undefined);
        }
        gatewayHost.revokeRun(runId);
        await artifactService.cleanupRun(runId).catch(() => undefined);
        await environmentSecrets.finalizeRun(runId).catch(() => undefined);
        await modelCredentialBroker.discardRun(runId).catch(() => undefined);
        throw error;
      }
      const client = createClient({ baseUrl: ensured.endpoint.baseUrl });
      const publicRuntime = Object.freeze({
        runId,
        botId: normalized.run.botId,
        channelId: normalized.run.channelId,
        revisionId: normalized.run.revisionId,
        compiledHash: compiled.compiledHash,
        endpoint: ensured.endpoint,
        model: prepared.model,
        modelSnapshot: prepared.modelSnapshot,
      });
      const eventController = new AbortController();
      const active = {
        ...publicRuntime,
        client,
        publicRuntime,
        eventController,
        eventTask: null,
        attachmentParts: Object.freeze((materialized?.attachments || [])
          .filter((attachment) => (
            attachment.delivery === 'native' && normalized.attachmentDeliveryMode === 'auto'
          ))
          .map((attachment) => Object.freeze({
            type: 'file',
            mime: attachment.mime,
            filename: attachment.filename,
            url: attachment.url,
          }))),
        attachmentTextParts: Object.freeze((materialized?.attachments || [])
          .filter((attachment) => attachment.delivery === 'inline_text')
          .map((attachment) => Object.freeze({
            type: 'text',
            synthetic: true,
            text: `<devryan_bot_attachment_user_data>${taggedJson({
              kind: 'untrusted_user_data',
              filename: attachment.filename,
              mime: attachment.mime,
              truncated: attachment.truncated === true,
              text: attachment.inlineText ?? '',
            })}</devryan_bot_attachment_user_data>`,
          }))),
        attachmentManifest: Object.freeze((materialized?.attachments || []).map((attachment) => Object.freeze({
          filename: attachment.filename,
          mime: attachment.mime,
          bytes: attachment.bytes,
          path: `.devryan/${attachment.relativePath}`,
          delivery: normalized.attachmentDeliveryMode === 'compatibility'
            && attachment.delivery === 'native'
            ? 'mounted'
            : attachment.delivery,
          truncated: attachment.truncated === true,
        }))),
      };
      activeRuns.set(runId, active);
      active.eventTask = Promise.resolve().then(() => subscribeToEvents({
        client,
        signal: eventController.signal,
        onEvent: (event) => {
          if (!event || !eventHandler) return;
          void Promise.resolve(eventHandler({ runId, event })).catch((error) => {
            logger?.warn?.('[BotsOpenCode] event handler rejected an event', {
              code: error?.code || 'bot_opencode_event_handler_failed',
              runId,
            });
          });
        },
      })).catch((error) => {
        if (eventController.signal.aborted) return;
        logger?.warn?.('[BotsOpenCode] scoped event stream disconnected', {
          code: error?.code || 'bot_opencode_event_stream_failed',
          runId,
        });
      });
      return publicRuntime;
    },

    async createSegment(input = {}) {
      exactMethodInput(input, 'Bot segment request', ['runId', 'title']);
      const active = requireActive(input.runId);
      const response = await active.client.session.create({
        directory: WORKSPACE_DIRECTORY,
        title: normalizeSessionTitle(input.title),
      });
      const session = unwrap(response, 'Bot session creation', { logger });
      if (!session || typeof session.id !== 'string' || !session.id) {
        fail('Bot session creation returned an invalid session', 'bot_opencode_response_invalid', 502);
      }
      return session;
    },

    async prompt(input = {}) {
      exactMethodInput(input, 'Bot prompt request', ['runId', 'sessionId', 'parts']);
      const active = requireActive(input.runId);
      const normalizedSessionId = normalizeSessionId(input.sessionId);
      const prompt = {
        sessionID: normalizedSessionId,
        directory: WORKSPACE_DIRECTORY,
        agent: 'bot',
        model: {
          providerID: active.model.providerId,
          modelID: active.model.modelId,
        },
        ...(active.model.variant ? { variant: active.model.variant } : {}),
        parts: partsWithRunMarker([
          ...input.parts,
          ...(active.attachmentManifest.length > 0 ? [{
            type: 'text',
            synthetic: true,
            text: `<devryan_bot_attachments>${taggedJson(active.attachmentManifest)}</devryan_bot_attachments>`,
          }] : []),
          ...active.attachmentTextParts,
          ...active.attachmentParts,
        ], active.runId),
      };
      await active.client.session.promptAsync(prompt, { throwOnError: false }).then((result) => unwrap(
        result,
        'Bot prompt',
        { allowEmpty: true, logger },
      ));
      return Object.freeze({ accepted: true, model: active.model });
    },

    runNoToolsStructured,

    runNoToolsExtraction(input = {}) {
      exactMethodInput(input, 'Bot no-tools extraction request', ['runId', 'prompt', 'schema']);
      const runId = validateUuid(input.runId, 'runId');
      return runNoToolsStructured({
        runId,
        prompt: input.prompt,
        schema: input.schema,
        title: `Bot memory extraction ${runId.slice(0, 8)}`,
        system: 'Extract structured memory only. Do not call tools or perform actions.',
      });
    },

    async inspectSegment(input = {}) {
      exactMethodInput(input, 'Bot segment inspection', ['runId', 'sessionId']);
      const active = requireActive(input.runId);
      const sessionId = normalizeSessionId(input.sessionId);
      if (typeof active.client.session?.messages !== 'function'
        || typeof active.client.session?.status !== 'function') {
        fail('Bot segment inspection is unavailable', 'bot_opencode_inspection_unavailable', 502);
      }
      const [messageResponse, statusResponse] = await Promise.all([
        active.client.session.messages({
          sessionID: sessionId,
          directory: WORKSPACE_DIRECTORY,
          limit: 100,
        }),
        active.client.session.status({ directory: WORKSPACE_DIRECTORY }),
      ]);
      const records = unwrap(messageResponse, 'Bot segment messages', { logger });
      const statuses = unwrap(statusResponse, 'Bot segment status', { logger });
      if (!Array.isArray(records) || !statuses || typeof statuses !== 'object') {
        fail('Bot segment inspection returned invalid data', 'bot_opencode_response_invalid', 502);
      }
      const marker = botRunMarker(active.runId);
      const promptRecord = [...records].reverse().find((record) => (
        record?.info?.role === 'user' && recordText(record).includes(marker)
      )) || null;
      let assistantRecord = null;
      if (promptRecord) {
        const promptId = promptRecord.info?.id;
        const direct = records.filter((record) => (
          record?.info?.role === 'assistant'
          && typeof promptId === 'string'
          && record.info.parentID === promptId
        ));
        assistantRecord = latestRecord(direct);
        if (!assistantRecord) {
          const promptIndex = records.indexOf(promptRecord);
          assistantRecord = latestRecord(records.slice(promptIndex + 1).filter((record) => (
            record?.info?.role === 'assistant'
          )));
        }
      }
      const statusType = typeof statuses[sessionId]?.type === 'string'
        ? statuses[sessionId].type.trim().toLowerCase()
        : '';
      const contextLimit = Number(active.modelSnapshot?.contextLimit || 0);
      return Object.freeze({
        promptObserved: Boolean(promptRecord),
        status: !statusType || statusType === 'idle' ? 'idle' : 'busy',
        assistantMessageId: typeof assistantRecord?.info?.id === 'string'
          ? assistantRecord.info.id
          : null,
        assistantText: assistantRecord ? recordText(assistantRecord) : '',
        assistantProjection: projectBotAssistantResponse(assistantRecord?.parts),
        assistantTerminal: isTerminalAssistantRecord(assistantRecord),
        providerContextRatio: contextLimit > 0
          ? Math.min(1, tokenTotal(assistantRecord?.info?.tokens) / contextLimit)
          : 0,
      });
    },

    async exportGeneratedImage(input = {}) {
      exactMethodInput(input, 'Bot generated image export', ['runId', 'path']);
      const active = requireActive(input.runId);
      if (typeof dockerProvider.exportWorkspaceImage !== 'function') {
        fail('Bot generated image export is unavailable', 'bot_image_publication_failed', 503);
      }
      return dockerProvider.exportWorkspaceImage({
        botId: active.botId,
        channelId: active.channelId,
        path: input.path,
      });
    },

    async abort(input = {}) {
      exactMethodInput(input, 'Bot abort request', ['runId', 'sessionId']);
      const active = requireActive(input.runId);
      const normalizedSessionId = normalizeSessionId(input.sessionId);
      const result = await active.client.session.abort({
        sessionID: normalizedSessionId,
        directory: WORKSPACE_DIRECTORY,
      });
      return unwrap(result, 'Bot abort', { allowEmpty: true, logger });
    },

    async stopReasoningRun(runId) {
      const active = requireActive(runId);
      await stopActive(active);
      return Object.freeze({ stopped: true, runId: active.runId });
    },

    inspectRun(runId) {
      return requireActive(runId).publicRuntime;
    },

    getActiveRunCount: () => activeRuns.size,

    async shutdown() {
      if (shutdownStarted) return;
      shutdownStarted = true;
      const failures = [];
      for (const active of [...activeRuns.values()]) {
        try {
          await stopActive(active);
        } catch (error) {
          gatewayHost.revokeRun(active.runId);
          failures.push(error);
        }
      }
      await gatewayHost.shutdown();
      started = false;
      if (failures.length > 0) {
        logger?.warn?.('[BotsOpenCode] scoped runtime shutdown was incomplete', {
          code: 'bot_opencode_shutdown_incomplete',
          failedRunCount: failures.length,
        });
        fail('One or more scoped Bot runtimes could not be stopped', 'bot_opencode_shutdown_incomplete', 500);
      }
    },
  });
}
