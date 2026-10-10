import http from 'node:http';

const failure = (code = 'bot_oauth_coordinator_unavailable', bot = false) => Object.assign(
  new Error(`${code}: ${code === 'bot_opencode_provider_authentication'
    ? `Reconnect the selected host OpenAI account in Providers${bot ? ' and Bot Settings' : ''}.`
    : 'Managed OpenAI authentication is unavailable.'}`),
  { code },
);

// Native HTTP emits no browser metadata. The private Bot gateway deliberately
// rejects browser fetch requests even when someone supplies a copied bearer.
const privatePost = (url, init) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: 'POST', headers: init.headers, signal: init.signal }, (response) => {
    const chunks = [];
    let bytes = 0;
    response.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024) { response.destroy(); reject(failure()); return; }
      chunks.push(chunk);
    });
    response.on('error', () => reject(failure()));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
  });
  request.on('error', () => reject(failure()));
  request.end(init.body);
});

// A timeout composed through AbortSignal.any() is only weakly held by the
// composite and can be collected before it fires (Node). Own the timer.
const boundedSignal = (signal, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Managed OpenAI authentication timed out.', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward(); else signal?.addEventListener('abort', forward, { once: true });
  return { signal: controller.signal, release: () => { clearTimeout(timer); signal?.removeEventListener('abort', forward); } };
};

function createAccessClient(environment, fetchImpl = privatePost) {
  const bot = Boolean(environment.DEVRYAN_BOT_GATEWAY_URL);
  const base = bot ? environment.DEVRYAN_BOT_GATEWAY_URL : environment.DEVRYAN_OPENAI_OAUTH_URL;
  const token = bot ? environment.DEVRYAN_BOT_RUNTIME_TOKEN : environment.DEVRYAN_OPENAI_OAUTH_TOKEN;
  if (!base && !token) return null;
  const url = new URL(base);
  // In a Bot the gateway is the egress service's in-network relay; the
  // container has no route to the host. On the host it is plain loopback.
  if (url.protocol !== 'http:' || url.hostname !== (bot ? 'egress' : '127.0.0.1')
    || (bot ? url.port !== '43121' : !url.port)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw failure();
  return async (operation, { signal } = {}) => {
    const bound = boundedSignal(signal, 20_000);
    let response;
    try {
      response = await fetchImpl(new URL(bot ? '/api/bots/private/oauth' : `/${operation}`, url), {
        method: 'POST', redirect: 'error', signal: bound.signal,
        headers: { authorization: `Bearer ${token}`, ...(bot ? { 'content-type': 'application/json' } : {}) },
        ...(bot ? { body: JSON.stringify({ operation, protocol: 1 }) } : {}),
      });
    } finally { bound.release(); }
    if (Number(response.headers.get('content-length')) > 32 * 1024) { await response.body?.cancel(); throw failure(); }
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32 * 1024) throw failure();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw failure(['bot_opencode_provider_authentication', 'bot_oauth_refresh_unavailable',
      'bot_oauth_persistence_failed'].includes(value.code) ? value.code : 'bot_oauth_coordinator_unavailable', bot);
    if (operation === 'ready') {
      if (value.protocol !== 1) throw failure();
      return value;
    }
    if (typeof value.accessToken !== 'string' || !value.accessToken
      || typeof value.accountId !== 'string' || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= Date.now()) throw failure();
    return value;
  };
}

// One policy at both physical send boundaries; API-key transports never call it.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
const unsupportedFields = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'];
const policyFailure = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const localTool = tool => object(tool) && ['function', 'custom'].includes(tool.type) && typeof tool.name === 'string' && tool.name.length > 0;
function toolsPolicy(tools) {
  if (!Array.isArray(tools)) throw policyFailure('chatgpt_siwc_tool_unsupported');
  const local = [], grouped = [];
  for (const tool of tools) {
    if (localTool(tool)) local.push(tool);
    else if (object(tool) && tool.type === 'web_search') grouped.push(tool);
    else if (object(tool) && tool.type === 'namespace' && typeof tool.name === 'string' && tool.name
      && Array.isArray(tool.tools) && tool.tools.every(localTool)) grouped.push(tool);
    else throw policyFailure('chatgpt_siwc_tool_unsupported');
  }
  return { local, grouped };
}
function encodeBody(value) {
  if (!object(value) || !Array.isArray(value.input)) throw policyFailure('chatgpt_siwc_context_required');
  const next = { ...value, store: false, stream: true };
  for (const field of unsupportedFields) delete next[field];
  next.input = value.input.map(item => {
    if (!object(item)) throw policyFailure('chatgpt_siwc_context_required');
    if (item.type === 'additional_tools') { toolsPolicy(item.tools); return item; }
    if (Array.isArray(item.content) && item.content.some(part => object(part) && /audio|video/.test(String(part.type))))
      throw policyFailure('chatgpt_siwc_input_unsupported');
    return item.role === 'system' ? { ...item, role: 'developer' } : item;
  });
  if (next.tools !== undefined) {
    const { local, grouped } = toolsPolicy(next.tools);
    // A generated namespace would change the native registry's exact tool lookup.
    if (local.length) next.input.push({ type: 'additional_tools', tools: local });
    if (grouped.length) next.tools = grouped; else delete next.tools;
  }
  if (next.tool_choice !== undefined && !object(next.tool_choice) && !['none', 'auto', 'required'].includes(next.tool_choice))
    throw policyFailure('chatgpt_siwc_tool_unsupported');
  if (object(next.tool_choice) && !['function', 'custom', 'allowed_tools', 'web_search'].includes(next.tool_choice.type))
    throw policyFailure('chatgpt_siwc_tool_unsupported');
  if (object(next.tool_choice) && next.tool_choice.type === 'allowed_tools') toolsPolicy(next.tool_choice.tools);
  return JSON.stringify(next);
}
async function encodeRequest(request) {
  if (request.method !== 'POST' || !request.body) throw policyFailure('chatgpt_siwc_context_required');
  const reader = request.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024 * 1024) throw policyFailure('chatgpt_siwc_request_too_large');
      chunks.push(value);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw policyFailure('chatgpt_siwc_request_invalid'); }
    return encodeBody(value);
  } finally { await reader.cancel().catch(() => {}); }
}
function completedResponse(response) {
  if (!response.ok) return response; // Preserve provider HTTP error classification.
  const contentType = response.headers.get('content-type');
  if (!response.body || (contentType && contentType.split(';')[0].trim().toLowerCase() !== 'text/event-stream'))
    throw policyFailure('chatgpt_siwc_stream_required');
  // The direct SIWC route can omit Content-Type; framing and completion still validate every response.
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let pending = '', terminal = false;
  const consume = (frame, controller) => {
    if (Buffer.byteLength(frame) > 1024 * 1024) throw policyFailure('chatgpt_siwc_stream_invalid');
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    // Match the native SSE reader's comment and null keepalives.
    if (!data || data === 'null' || data.startsWith(':')) return;
    if (data === '[DONE]') throw policyFailure('chatgpt_siwc_stream_interrupted');
    let event;
    try { event = JSON.parse(data); } catch { throw policyFailure('chatgpt_siwc_stream_invalid'); }
    if (!object(event) || typeof event.type !== 'string') throw policyFailure('chatgpt_siwc_stream_invalid');
    const failed = ['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type);
    if (!failed && (event.error || event.response?.error || ['failed', 'incomplete', 'cancelled'].includes(event.response?.status)))
      throw policyFailure('chatgpt_siwc_stream_failed');
    if (event.type === 'response.completed' && ((event.response?.status && event.response.status !== 'completed')
      || event.response?.incomplete_details)) throw policyFailure('chatgpt_siwc_stream_failed');
    // Preserve provider failures for the native parser, including their code and param.
    controller.enqueue(encoder.encode(frame + '\n\n'));
    if (failed || event.type === 'response.completed') {
      terminal = true;
      controller.terminate();
    }
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let separator;
      while (!terminal && (separator = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        consume(frame, controller);
      }
      if (terminal) pending = '';
      if (Buffer.byteLength(pending) > 1024 * 1024) throw policyFailure('chatgpt_siwc_stream_invalid');
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) consume(pending, controller);
      if (!terminal) throw policyFailure('chatgpt_siwc_stream_interrupted');
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function createTransport(access, fetchImpl = fetch) {
  return async (input, init = {}) => {
    const original = new Request(input, init), url = new URL(original.url);
    if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/codex/responses') {
      url.hostname = 'api.openai.com'; url.pathname = '/v1/responses';
    }
    if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses'
      || url.search || url.hash || url.username || url.password) throw failure('bot_oauth_target_denied');
    const signal = init.signal || original.signal;
    signal?.throwIfAborted();
    const body = await encodeRequest(original); // Refuse unsupported tools before even requesting credentials.
    signal?.throwIfAborted();
    const current = await access('access', { signal });
    signal?.throwIfAborted();
    const headers = new Headers(original.headers);
    headers.set('authorization', `Bearer ${current.accessToken}`);
    headers.set('content-type', 'application/json'); headers.delete('content-length');
    for (const name of ['chatgpt-account-id', 'x-opencode-title', 'x-openai-internal-codex-residency']) headers.delete(name);
    return completedResponse(await fetchImpl(url, { ...init, method: 'POST', headers, redirect: 'error', body, signal }));
  };
}

// OpenCode answers provider discovery only after every plugin has registered,
// and the Bot host treats that answer as its readiness probe. Registration
// therefore never waits on the gateway: the handshake starts immediately with
// a short bound and the hooks await its outcome.
const READY_HANDSHAKE_TIMEOUT_MS = 5_000;

async function plugin(_input, options = {}) {
  const environment = options.environment || process.env;
  const access = createAccessClient(environment, options.fetchImpl);
  if (!access) return {};
  // A failed handshake must not cause OpenCode to drop this plugin and silently
  // fall back to its independent refresh loader. Keep a failing transport.
  const readyTimeoutMs = Number.isFinite(options.readyTimeoutMs) ? options.readyTimeoutMs : READY_HANDSHAKE_TIMEOUT_MS;
  const readyBound = boundedSignal(null, readyTimeoutMs);
  const ready = access('ready', { signal: readyBound.signal }).catch(() => ({ oauth: true })).finally(readyBound.release);
  return {
    async 'tool.execute.before'(input) {
      if ((await ready).oauth && ['gpt_imagegen', 'devryan_image'].includes(input.tool))
        throw policyFailure('chatgpt_siwc_tool_unsupported');
    },
    // Config options are applied after built-in auth loaders. Leave their
    // login methods, provider models, parameters and header hooks intact.
    async config(config) {
      if (!(await ready).oauth) return;
      config.provider ||= {};
      config.provider.openai ||= {};
      config.provider.openai.options ||= {};
      config.provider.openai.options.fetch = createTransport(access, options.fetchImpl);
    },
  };
}

// Every module export is a plugin entry; share policy through the one factory.
Object.defineProperty(plugin, 'siwcPolicy', { value: Object.freeze({ encodeRequest, encodeBody, completedResponse }) });
plugin.testing = { createAccessClient, createTransport };
export default plugin;
