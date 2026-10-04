import { randomUUID } from 'node:crypto';
import { createOpenCodeClient } from '../opencode/opencode-client/index.js';
import { readResponseBody } from '../opencode/opencode-client/envelope.js';
import { buildDevryanPromptMetadata, buildV2PromptContent } from '../opencode/v2/admission.js';
import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { botRequestSignal } from './request-lifetime.js';

const DIRECTORY = '/workspace';
const invalidResponse = () => Object.assign(new Error('Invalid native Bot response'), {
  code: 'bot_opencode_response_invalid', statusCode: 502,
});

// Keep the Bot provider's result contract; every transport below is native v2.
const result = async (operation) => {
  try { return { data: await operation() }; }
  catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    const status = error?.statusCode ?? error?.status ?? 502;
    return { error: { name: status === 401 ? 'ProviderAuthError' : 'NativeBotError', code: error?.code },
      response: { status } };
  }
};

export function createBotNativeClient({ baseUrl, token, runId, fetchImpl = fetch, recordDiagnostic } = {}) {
  if (typeof token !== 'string' || token.length < 32 || typeof runId !== 'string' || !runId) {
    throw new TypeError('Native Bot client requires its run capability');
  }
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new TypeError('Native Bot endpoint must be loopback');
  }
  const lifetime = new AbortController();
  const getRuntime = () => ({ generation: 2, baseUrl: endpoint.origin, version: '2.0.20', epoch: runId });
  const getAuthHeaders = () => ({ authorization: `Bearer ${token}` });
  let hub;
  const client = createOpenCodeClient({ getRuntime, getAuthHeaders, fetchImpl,
    policy: { allowedRoots: () => [DIRECTORY] }, projector: () => hub?.getProjector(), recordDiagnostic });
  hub = createGlobalMessageStreamHub({ openCodeClient: client, getOpenCodeRuntime: getRuntime,
    getOpenCodeAuthHeaders: getAuthHeaders, fetchImpl, upstreamReconnectDelayMs: 500, recordDiagnostic });
  const options = (input = {}) => ({ ...input, directory: DIRECTORY,
    signal: botRequestSignal(input.signal, lifetime.signal, input.timeoutMs ?? 30_000) });
  const request = async (path, body, input = {}) => {
    const { signal } = options(input);
    const response = await fetchImpl(`${endpoint.origin}${path}`, {
      method: 'POST', headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal,
    });
    const read = await readResponseBody(response, { maxResponseBytes: 256 * 1024, signal });
    if (!response.ok) throw Object.assign(new Error('Native Bot operation failed'), {
      statusCode: response.status, code: typeof read.value?.code === 'string' ? read.value.code : 'bot_opencode_request_failed',
    });
    if (!read.parsed || !read.value || typeof read.value !== 'object') throw invalidResponse();
    return read.value;
  };
  return Object.freeze({
    generation: () => 2,
    provider: { list: (query, input) => result(() => client.catalog.providerList({ ...query, directory: DIRECTORY }, options(input))) },
    session: {
      create: (body, input) => result(() => client.sessions.create({ ...body, directory: DIRECTORY }, options(input))),
      messages: (body, input) => result(async () => (await client.sessions.messages(body.sessionID,
        { limit: body.limit }, options(input)))?.records),
      status: (query, input) => result(() => client.sessions.status({ ...query, directory: DIRECTORY }, options(input))),
      abort: (body, input) => result(() => client.sessions.abort(body.sessionID, options(input))),
      promptAsync: (body, input) => result(async () => {
        const content = buildV2PromptContent(body.parts, { operation: 'bot.prompt' });
        if (body.agent !== 'bot' || !body.model?.providerID || !body.model?.modelID || content.agents.length) {
          throw new TypeError('Native Bot prompt selection is invalid');
        }
        const model = { providerID: body.model.providerID, id: body.model.modelID,
          ...(body.variant ? { variant: body.variant } : {}) };
        const reply = await request('/devryan/bot/prompt', { sessionID: body.sessionID, model, prompt: {
          id: `msg_${randomUUID().replaceAll('-', '')}`, text: content.text,
          ...(content.files.length ? { files: content.files } : {}), delivery: 'queue',
          metadata: { devryan: buildDevryanPromptMetadata({ origin: 'bot', agent: 'bot',
            providerID: model.providerID, modelID: model.id, variant: model.variant,
            planMode: false, parts: content.segments }, { text: content.text }) },
        } }, input);
        if (reply.accepted !== true) throw invalidResponse();
        return true;
      }),
    },
    structured: (body, input) => result(async () => {
      const reply = await request('/devryan/bot/structured', body, { ...input, timeoutMs: 120_000 });
      if (!Object.hasOwn(reply, 'output')) throw invalidResponse();
      return reply.output;
    }),
    async subscribeEvents({ signal, onEvent }) {
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      const unsubscribe = hub.subscribeDirectoryEvent(DIRECTORY, (entry) => onEvent(entry.payload));
      const subscriptionSignal = AbortSignal.any([lifetime.signal, signal].filter(Boolean));
      try {
        hub.start();
        await new Promise((resolve) => {
          if (subscriptionSignal.aborted) resolve();
          else subscriptionSignal.addEventListener('abort', resolve, { once: true });
        });
      } finally { unsubscribe(); hub.stop(); }
    },
    close() { lifetime.abort(); hub.stop(); },
  });
}
