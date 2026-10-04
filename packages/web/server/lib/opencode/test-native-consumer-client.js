// Test-only adapter over in-memory fixture responders. No server or v1 runtime
// is constructed: consumers receive the same typed application API as native v2.
export const createNativeConsumerFixture = ({ readFixture, headers = () => ({}), baseUrl = 'http://opencode.test' } = {}) => {
  const request = async (pathname, query = {}, options = {}, method = 'GET', body, page = false) => {
    const url = new URL(pathname, typeof baseUrl === 'function' ? baseUrl() : baseUrl);
    for (const [key, value] of Object.entries({ ...query, directory: options.directory ?? query.directory })) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 5000);
    const auth = await headers();
    signal.throwIfAborted();
    const response = await readFixture(url.toString(), {
      method, headers: { Accept: 'application/json', ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    signal.throwIfAborted();
    if (!response?.ok) {
      if (response?.status === 404 && options.allowNotFound) return null;
      throw Object.assign(new Error('Native fixture request refused'), { code: 'opencode_http_error', statusCode: response?.status ?? 503 });
    }
    let payload;
    let bytes = 0;
    options.onResponseRead?.({ phase: 'start', bytes: 0 });
    try {
      if (typeof response.text === 'function') {
        const text = await response.text(); bytes = Buffer.byteLength(text);
        options.onResponseRead?.({ phase: 'chunk', bytes });
        if (bytes > (options.maxResponseBytes ?? 8 * 1024 * 1024)) {
          throw Object.assign(new Error('Native fixture response too large'), { code: 'opencode_response_too_large' });
        }
        payload = text ? JSON.parse(text) : null;
      } else payload = typeof response.json === 'function' ? await response.json() : true;
      signal.throwIfAborted();
      return page ? { records: payload, cursor: response.headers?.get?.('x-next-cursor') ?? undefined } : payload;
    } finally { options.onResponseRead?.({ phase: 'end', bytes }); }

  };
  const sessionPath = id => `/session/${encodeURIComponent(id)}`;
  return {
    generation: () => 2,
    events: { url: () => new URL('/api/event', typeof baseUrl === 'function' ? baseUrl() : baseUrl).href },
    prompts: { prompt: (id, body, options) => request(`${sessionPath(id)}/prompt_async`, {}, options, 'POST', body) },
    sessions: {
      get: (id, options) => request(sessionPath(id), {}, options),
      children: (id, options) => request(`${sessionPath(id)}/children`, {}, options),
      list: (query, options) => request('/session', query, options),
      search: async (query, options) => {
        const payload = await request('/experimental/session', query, options);
        return { sessions: Array.isArray(payload) ? payload : payload?.sessions ?? [], cursor: payload?.cursor };
      },
      create: ({ directory, ...input }, options) => request('/session', { directory }, options, 'POST', input),
      update: (id, patch, options) => request(sessionPath(id), {}, options, 'PATCH', patch),
      archive: (id, archived, options) => request(sessionPath(id), {}, options, 'PATCH', { time: { archived } }),
      remove: (id, options) => request(sessionPath(id), {}, options, 'DELETE'),
      fork: (id, input, options) => request(`${sessionPath(id)}/fork`, {}, options, 'POST', input),
      abort: (id, options) => request(`${sessionPath(id)}/abort`, {}, options, 'POST'),
      messages: (id, query, options) => request(`${sessionPath(id)}/message`, query, options, 'GET', undefined, true),
      message: (id, messageID, options) => request(`${sessionPath(id)}/message/${encodeURIComponent(messageID)}`, {}, options),
      todo: (id, options) => request(`${sessionPath(id)}/todo`, {}, options),
      status: (query, options) => request('/session/status', query, options),
    },
    interaction: {
      permissions: { list: (query, options) => request('/permission', query, options) },
      questions: {
        list: (query, options) => request('/question', query, options),
        reply: (id, body, options) => request(`/question/${encodeURIComponent(id)}/reply`, {}, options, 'POST', body),
      },
    },
    catalog: Object.fromEntries([
      ['config', '/config'], ['providers', '/config/providers'], ['providerList', '/provider'],
      ['agents', '/agent'], ['skills', '/skill'], ['commands', '/command'], ['mcp', '/mcp'], ['project', '/project/current'],
    ].map(([name, pathname]) => [name, (query, options) => request(pathname, query, options)]).concat([
      ['tools', async (query, options) => {
        const ids = await request('/experimental/tool/ids', { directory: query.directory }, options);
        const definitions = query.providerID && query.modelID
          ? await request('/experimental/tool', { directory: query.directory, provider: query.providerID, model: query.modelID }, options)
          : [];
        return { ids, definitions };
      }],
    ])),
    health: { runtimeInfo: options => request('/api/info', {}, options), probe: async options => {
      const payload = await request('/global/health', {}, options);
      return { ready: payload?.healthy !== false, version: payload?.version ?? '2.0.20' };
    } },
  };
};
