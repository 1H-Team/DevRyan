import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';

const failure = (code = 'bot_oauth_coordinator_unavailable') => Object.assign(
  new Error(`${code}: ${code === 'bot_opencode_provider_authentication'
    ? 'Reconnect the selected host OpenAI account in Providers and Bot Settings.'
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

function createAccessClient(environment, fetchImpl = privatePost) {
  const bot = Boolean(environment.DEVRYAN_BOT_GATEWAY_URL);
  const base = bot ? environment.DEVRYAN_BOT_GATEWAY_URL : environment.DEVRYAN_OPENAI_OAUTH_URL;
  const token = bot ? environment.DEVRYAN_BOT_RUNTIME_TOKEN : environment.DEVRYAN_OPENAI_OAUTH_TOKEN;
  if (!base && !token) return null;
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== (bot ? 'host.docker.internal' : '127.0.0.1')
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw failure();
  return async (operation, { signal } = {}) => {
    const response = await fetchImpl(new URL(bot ? '/api/bots/private/oauth' : `/${operation}`, url), {
      method: 'POST', redirect: 'error', signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, ...(bot ? { 'content-type': 'application/json' } : {}) },
      ...(bot ? { body: JSON.stringify({ operation, protocol: 1 }) } : {}),
    });
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
      'bot_oauth_persistence_failed'].includes(value.code) ? value.code : 'bot_oauth_coordinator_unavailable');
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

function createTransport(access, fetchImpl = fetch) {
  return async (input, init = {}) => {
    const original = input instanceof Request ? input : new Request(input, init);
    const url = new URL(original.url);
    // Never attach credentials to caller-selected origins or follow redirects.
    if (!['api.openai.com', 'chatgpt.com'].includes(url.hostname) || url.protocol !== 'https:'
      || (url.port && url.port !== '443') || url.username || url.password) throw failure('bot_oauth_target_denied');
    const signal = init.signal || original.signal;
    signal?.throwIfAborted();
    let current;
    try { current = await access('access', { signal }); } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
    signal?.throwIfAborted();
    const headers = new Headers(original.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('authorization', `Bearer ${current.accessToken}`);
    headers.set('ChatGPT-Account-Id', current.accountId);
    headers.delete('x-opencode-title');
    const rewrite = url.pathname.includes('/v1/responses') || url.pathname.includes('/chat/completions');
    if (rewrite) {
      url.href = 'https://chatgpt.com/backend-api/codex/responses';
      try {
        const claims = JSON.parse(Buffer.from(current.accessToken.split('.')[1], 'base64url').toString('utf8'));
        const residency = claims['https://api.openai.com/auth']?.chatgpt_compute_residency;
        if (typeof residency === 'string' && residency !== 'no_constraint') headers.set('x-openai-internal-codex-residency', residency);
      } catch { /* account identity comes from the coordinator, not JWT parsing */ }
    }
    return fetchImpl(url, { ...init, method: init.method || original.method, headers, redirect: 'error',
      body: init.body ?? original.body, signal: init.signal || original.signal,
      ...(original.body ? { duplex: 'half' } : {}),
    });
  };
}

async function plugin(_input, options = {}) {
  const environment = options.environment || process.env;
  const access = createAccessClient(environment, options.fetchImpl);
  if (!access) return {};
  // A failed handshake must not cause OpenCode to drop this plugin and silently
  // fall back to its independent refresh loader. Keep a failing transport.
  const ready = await access('ready').catch(() => ({ oauth: true }));
  let imageWrite = Promise.resolve();
  return {
    async 'tool.execute.before'(input) {
      if (!ready.oauth || !['gpt_imagegen', 'devryan_image'].includes(input.tool)) return;
      if (!environment.DEVRYAN_BOT_GATEWAY_URL) { await access('access'); return; }
      // The pinned image tool reads the scoped auth file directly. Update its
      // existing bind-mounted inode; never put a reusable refresh token there.
      imageWrite = imageWrite.catch(() => {}).then(async () => {
        const current = await access('access');
        const handle = await fs.open(options.scopedAuthFile || '/data/opencode/auth.json', constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          const bytes = Buffer.from(JSON.stringify({ openai: { type: 'oauth', access: current.accessToken,
            refresh: '', expires: current.expiresAt, accountId: current.accountId } }));
          await handle.write(bytes, 0, bytes.length, 0);
          await handle.truncate(bytes.length);
          await handle.sync();
        } finally { await handle.close(); }
      });
      await imageWrite;
    },
    // Config options are applied after built-in auth loaders. Leave their
    // login methods, provider models, parameters and header hooks intact.
    async config(config) {
      if (!ready.oauth) return;
      config.provider ||= {};
      config.provider.openai ||= {};
      config.provider.openai.options ||= {};
      config.provider.openai.options.fetch = createTransport(access, options.fetchImpl);
    },
  };
}

// Only the factory is exported: OpenCode treats every function export as a plugin.
plugin.testing = { createAccessClient, createTransport };
export default plugin;
