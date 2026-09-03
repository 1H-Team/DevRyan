import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/plugin', () => {
  const makeSchema = () => {
    const schema = {
      describe: () => schema,
      optional: () => schema,
      int: () => schema,
      min: () => schema,
      max: () => schema,
    };
    return schema;
  };
  const mockTool = (definition) => definition;
  mockTool.schema = {
    array: makeSchema,
    number: makeSchema,
    string: makeSchema,
  };
  return { tool: mockTool };
});

const browserPluginModule = await import('./devryan-browser.mjs');
const { DevRyanBrowserPlugin, __test, wrapBrowserEvalSnippet } = browserPluginModule;

const ORIGINAL_ENVIRONMENT = {
  discoveryUrl: process.env.DEVRYAN_BROWSER_CDP_DISCOVERY_URL,
  token: process.env.DEVRYAN_BROWSER_CDP_TOKEN,
  binary: process.env.DEVRYAN_AGENT_BROWSER_BIN,
  config: process.env.AGENT_BROWSER_CONFIG,
  openaiKey: process.env.OPENAI_API_KEY,
};
let managedRoot;
let managedBinaryPath;
let managedConfigPath;

const context = (overrides = {}) => ({
  sessionID: 'ses_child',
  messageID: 'msg_turn',
  directory: '/workspace',
  agent: 'builder',
  abort: new AbortController().signal,
  ...overrides,
});

const makeChild = ({ stdout = '', stderr = '', code = 0, close = true } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (close) child.emit('close', code);
  });
  return child;
};

const stubLeaseFetch = ({
  wsUrl = 'ws://127.0.0.1:54321/devtools/page/private-capability',
  previewUrl,
  // 404 mimics an older server without the resolve route.
  resolveStatus = 200,
} = {}) => {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const request = {
      url: String(url),
      method: init.method,
      body: JSON.parse(init.body),
      authorization: init.headers.authorization,
      signal: init.signal,
    };
    requests.push(request);
    if (request.method === 'POST' && request.url.endsWith('/api/desktop/browser-leases/resolve')) {
      if (resolveStatus !== 200) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
          status: resolveStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ previewUrl: previewUrl ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (request.method === 'POST' && request.url.endsWith('/api/desktop/browser-leases')) {
      return new Response(JSON.stringify({
        leaseId: 'dvr_lease_1',
        wsUrl,
        created: requests.filter((entry) => entry.url.endsWith('/api/desktop/browser-leases')).length === 1,
        ...(previewUrl ? { previewUrl } : {}),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return requests;
};

beforeEach(() => {
  managedRoot = mkdtempSync(join(tmpdir(), 'devryan-browser-plugin-'));
  managedBinaryPath = join(managedRoot, 'node_modules', 'agent-browser', 'bin', 'agent-browser-darwin-arm64');
  managedConfigPath = join(managedRoot, 'devryan-agent-browser.json');
  mkdirSync(join(managedRoot, 'node_modules', 'agent-browser', 'bin'), { recursive: true });
  writeFileSync(managedBinaryPath, '', 'utf8');
  writeFileSync(managedConfigPath, '{}\n', 'utf8');
  process.env.DEVRYAN_BROWSER_CDP_DISCOVERY_URL = 'http://127.0.0.1:45678/api/desktop/browser-cdp';
  process.env.DEVRYAN_BROWSER_CDP_TOKEN = 'private-token';
  process.env.DEVRYAN_AGENT_BROWSER_BIN = managedBinaryPath;
  process.env.AGENT_BROWSER_CONFIG = '/untrusted/config.json';
  process.env.OPENAI_API_KEY = 'provider-secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(managedRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    DEVRYAN_BROWSER_CDP_DISCOVERY_URL: ORIGINAL_ENVIRONMENT.discoveryUrl,
    DEVRYAN_BROWSER_CDP_TOKEN: ORIGINAL_ENVIRONMENT.token,
    DEVRYAN_AGENT_BROWSER_BIN: ORIGINAL_ENVIRONMENT.binary,
    AGENT_BROWSER_CONFIG: ORIGINAL_ENVIRONMENT.config,
    OPENAI_API_KEY: ORIGINAL_ENVIRONMENT.openaiKey,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('DevRyan agent browser plugin', () => {
  it('exports only callable plugin factories for the OpenCode loader', () => {
    expect(Object.values(browserPluginModule).every((value) => typeof value === 'function')).toBe(true);
    expect(__test()).toEqual({});
  });

  it('silently exposes no tool outside the managed three-variable contract', async () => {
    delete process.env.DEVRYAN_AGENT_BROWSER_BIN;
    await expect(DevRyanBrowserPlugin()).resolves.toEqual({});
  });

  it('acquires by exact tool context, connects once, forces namespace/session, and touches around commands', async () => {
    const requests = stubLeaseFetch();
    const calls = [];
    const spawnImpl = vi.fn((binary, args, options) => {
      calls.push({ binary, args, options });
      return makeChild({ stdout: args.includes('connect') ? 'connected\n' : 'Example title\n' });
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    const tool = plugin.tool.devryan_browser;

    await expect(tool.execute({ command: 'open', args: ['http://127.0.0.1:3000'] }, context()))
      .resolves.toBe('Example title');
    await expect(tool.execute({ command: 'snapshot', args: ['-i'] }, context()))
      .resolves.toBe('Example title');

    expect(calls.map((call) => call.args)).toEqual([
      ['--namespace', 'devryan', '--session', 'dvr_lease_1', '--config', managedConfigPath, '--idle-timeout', '2m', 'connect', 'ws://127.0.0.1:54321/devtools/page/private-capability'],
      ['--namespace', 'devryan', '--session', 'dvr_lease_1', '--config', managedConfigPath, '--idle-timeout', '2m', 'open', 'http://127.0.0.1:3000'],
      ['--namespace', 'devryan', '--session', 'dvr_lease_1', '--config', managedConfigPath, '--idle-timeout', '2m', 'snapshot', '-i'],
    ]);
    expect(calls.every((call) => call.binary === managedBinaryPath)).toBe(true);
    expect(calls.every((call) => call.options.env.AGENT_BROWSER_CONFIG === undefined)).toBe(true);
    expect(calls.every((call) => call.options.env.DEVRYAN_BROWSER_CDP_TOKEN === undefined)).toBe(true);
    expect(calls.every((call) => call.options.env.OPENAI_API_KEY === undefined)).toBe(true);
    expect(calls.every((call) => call.options.cwd === managedRoot)).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/api/desktop/browser-leases')))
      .toHaveLength(2);
    expect(requests.filter((request) => request.url.endsWith('/touch'))).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer private-token',
      body: {
        opencodeSessionID: 'ses_child',
        messageID: 'msg_turn',
        directory: '/workspace',
        agent: 'builder',
      },
    });
  });

  it('canonicalizes rotating assistant message IDs to one user turn and one browser lease', async () => {
    const requests = stubLeaseFetch();
    const spawnImpl = vi.fn((binary, args) => makeChild({
      stdout: args.includes('connect') ? 'connected\n' : 'verified\n',
    }));
    const client = {
      session: {
        messages: vi.fn(async () => ({
          data: [
            { info: { id: 'msg_user_turn', role: 'user' } },
            { info: { id: 'msg_assistant_open', role: 'assistant', parentID: 'msg_user_turn' } },
            { info: { id: 'msg_assistant_snapshot', role: 'assistant', parentID: 'msg_user_turn' } },
          ],
        })),
      },
    };
    const plugin = await DevRyanBrowserPlugin({ spawnImpl, client });
    const tool = plugin.tool.devryan_browser;

    await expect(tool.execute(
      { command: 'open', args: ['http://127.0.0.1:4173/'] },
      context({ messageID: 'msg_assistant_open' }),
    )).resolves.toBe('verified');
    await expect(tool.execute(
      { command: 'snapshot', args: ['-i'] },
      context({ messageID: 'msg_assistant_snapshot' }),
    )).resolves.toBe('verified');

    expect(spawnImpl.mock.calls.filter(([, args]) => args.includes('connect'))).toHaveLength(1);
    const acquireRequests = requests.filter((request) => request.url.endsWith('/api/desktop/browser-leases'));
    expect(acquireRequests).toHaveLength(2);
    expect(acquireRequests.map((request) => request.body.messageID))
      .toEqual(['msg_user_turn', 'msg_user_turn']);
    expect(client.session.messages).toHaveBeenCalledTimes(2);
  });

  it('opens the configured branch preview when open has no explicit URL', async () => {
    const requests = stubLeaseFetch({ previewUrl: 'https://dev1.1health.ae/' });
    const spawnImpl = vi.fn((binary, args) => makeChild({
      stdout: args.includes('connect') ? 'connected\n' : 'opened\n',
    }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    await expect(plugin.tool.devryan_browser.execute({ command: 'open' }, context()))
      .resolves.toBe('opened');
    expect(spawnImpl.mock.calls.some(([, args]) => (
      args.at(-2) === 'open' && args.at(-1) === 'https://dev1.1health.ae/'
    ))).toBe(true);
    // A resolved preview continues through the unchanged acquire path; the
    // acquire body is the plain scope, not the resolved URL.
    expect(requests.slice(0, 2).map((request) => [request.method, request.url])).toEqual([
      ['POST', 'http://127.0.0.1:45678/api/desktop/browser-leases/resolve'],
      ['POST', 'http://127.0.0.1:45678/api/desktop/browser-leases'],
    ]);
    expect(requests[1].body).toEqual(requests[0].body);
  });

  it('hands off a branch without a preview before any lease is acquired', async () => {
    const requests = stubLeaseFetch();
    const spawnImpl = vi.fn();
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    await expect(plugin.tool.devryan_browser.execute({ command: 'open' }, context()))
      .resolves.toBe(__test.NO_PREVIEW_HANDOFF_MESSAGE);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', 'http://127.0.0.1:45678/api/desktop/browser-leases/resolve'],
    ]);
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer private-token',
      body: {
        opencodeSessionID: 'ses_child',
        messageID: 'msg_turn',
        directory: '/workspace',
        agent: 'builder',
      },
    });
  });

  it('maps loopback opens to the configured preview and preserves the full resource path', () => {
    expect(__test.resolveOpenCommandArguments(
      ['http://127.0.0.1:8083/dashboard?mode=review#summary'],
      'https://dev1.1health.ae/',
    )).toEqual(['https://dev1.1health.ae/dashboard?mode=review#summary']);
    expect(__test.resolveOpenCommandArguments(
      ['https://www.1health.ae/dashboard?mode=review#summary'],
      'https://dev1.1health.ae/',
    )).toEqual(['https://www.1health.ae/dashboard?mode=review#summary']);
    expect(__test.resolveOpenCommandArguments(
      ['http://localhost:4173/dashboard?mode=review#summary'],
      '',
    )).toEqual(['http://localhost:4173/dashboard?mode=review#summary']);
  });

  it('returns a successful local handoff and releases a newly created unused lease', async () => {
    // An older server answers 404 on resolve, so the legacy acquire-then-
    // release handoff must keep working unchanged.
    const requests = stubLeaseFetch({ resolveStatus: 404 });
    const spawnImpl = vi.fn();
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    await expect(plugin.tool.devryan_browser.execute({ command: 'open' }, context()))
      .resolves.toBe(__test.NO_PREVIEW_HANDOFF_MESSAGE);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(requests.some((request) => request.url.endsWith('/touch'))).toBe(false);
    expect(requests.slice(0, 2).map((request) => [request.method, request.url])).toEqual([
      ['POST', 'http://127.0.0.1:45678/api/desktop/browser-leases/resolve'],
      ['POST', 'http://127.0.0.1:45678/api/desktop/browser-leases'],
    ]);
    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      url: 'http://127.0.0.1:45678/api/desktop/browser-leases/dvr_lease_1',
    });
  });

  it('leaves a reused lease untouched during the local handoff', async () => {
    const requests = stubLeaseFetch();
    const spawnImpl = vi.fn((binary, args) => makeChild({
      stdout: args.includes('connect') ? 'connected\n' : 'opened\n',
    }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    const tool = plugin.tool.devryan_browser;

    await expect(tool.execute(
      { command: 'open', args: ['http://127.0.0.1:4173/'] },
      context(),
    )).resolves.toBe('opened');
    const spawnCount = spawnImpl.mock.calls.length;
    const touchCount = requests.filter((request) => request.url.endsWith('/touch')).length;

    await expect(tool.execute({ command: 'open' }, context()))
      .resolves.toBe(__test.NO_PREVIEW_HANDOFF_MESSAGE);
    expect(spawnImpl).toHaveBeenCalledTimes(spawnCount);
    expect(requests.filter((request) => request.url.endsWith('/touch'))).toHaveLength(touchCount);
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
    // The held-lease check runs before resolve, so the reused lease is
    // consulted directly and no resolve request is made.
    expect(requests.some((request) => request.url.endsWith('/resolve'))).toBe(false);

    await expect(tool.execute({ command: 'close' }, context()))
      .resolves.toBe('Browser lease closed.');
  });

  it('preserves the branch preview authentication failure code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'branch_preview_auth_failed',
        message: 'Branch preview service-token authentication failed',
      },
    }), { status: 401, headers: { 'content-type': 'application/json' } })));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl: vi.fn() });

    await expect(plugin.tool.devryan_browser.execute({ command: 'open' }, context()))
      .rejects.toMatchObject({
        code: __test.BROWSER_ERROR_CODES.branchPreviewAuthFailed,
        statusCode: 401,
        retryable: false,
      });
  });

  it('makes close idempotent after lease authentication fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'branch_preview_auth_failed',
        message: 'Cloudflare Access rejected the branch preview service token',
      },
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);
    const spawnImpl = vi.fn();
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    await expect(plugin.tool.devryan_browser.execute({ command: 'open' }, context()))
      .rejects.toMatchObject({ code: __test.BROWSER_ERROR_CODES.branchPreviewAuthFailed });
    await expect(plugin.tool.devryan_browser.execute({ command: 'close' }, context()))
      .resolves.toBe('Browser lease already closed.');
    await expect(plugin.tool.devryan_browser.execute({ command: 'close' }, context()))
      .resolves.toBe('Browser lease already closed.');
    // The 401 on resolve falls through to a single acquire (no retry on an
    // auth failure), and neither close makes a request.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:45678/api/desktop/browser-leases/resolve',
      'http://127.0.0.1:45678/api/desktop/browser-leases',
    ]);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('retries idempotent lease acquisition once on 503 and executes the browser command once', async () => {
    let acquireCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init.method === 'POST' && String(url).endsWith('/api/desktop/browser-leases')) {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          return new Response(JSON.stringify({ error: { message: 'temporary lease outage' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          leaseId: 'dvr_retry_lease',
          wsUrl: 'ws://127.0.0.1:54321/devtools/page/retry',
          created: true,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const spawnImpl = vi.fn((binary, args) => makeChild({
      stdout: args.includes('connect') ? 'connected\n' : 'done\n',
    }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    await expect(plugin.tool.devryan_browser.execute({ command: 'snapshot' }, context()))
      .resolves.toBe('done');

    expect(acquireCalls).toBe(2);
    expect(spawnImpl.mock.calls.filter(([, args]) => args.includes('connect'))).toHaveLength(1);
    expect(spawnImpl.mock.calls.filter(([, args]) => args.includes('snapshot'))).toHaveLength(1);
  });

  it('retries turn lookup once after a transport failure without replaying the browser command', async () => {
    stubLeaseFetch();
    const client = {
      session: {
        messages: vi.fn()
          .mockRejectedValueOnce(new TypeError('fetch failed'))
          .mockResolvedValueOnce({
            data: [
              { info: { id: 'msg_user_retry', role: 'user' } },
              { info: { id: 'msg_assistant_retry', role: 'assistant', parentID: 'msg_user_retry' } },
            ],
          }),
      },
    };
    const spawnImpl = vi.fn((binary, args) => makeChild({
      stdout: args.includes('connect') ? 'connected\n' : 'done\n',
    }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl, client });

    await expect(plugin.tool.devryan_browser.execute(
      { command: 'snapshot' },
      context({ messageID: 'msg_assistant_retry' }),
    )).resolves.toBe('done');

    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(spawnImpl.mock.calls.filter(([, args]) => args.includes('snapshot'))).toHaveLength(1);
  });

  it('stops after the bounded lease retry and exposes a stable structured code', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'still unavailable' },
    }), { status: 504, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const spawnImpl = vi.fn();
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    let failure;
    try {
      await plugin.tool.devryan_browser.execute({ command: 'snapshot' }, context());
    } catch (error) {
      failure = error;
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      code: __test.BROWSER_ERROR_CODES.leaseAcquireFailed,
      statusCode: 504,
      retryable: true,
    });
    expect(failure.message).toContain('DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED');
  });

  it('rejects connection and daemon overrides before acquiring a lease', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const plugin = await DevRyanBrowserPlugin({ spawnImpl: vi.fn() });
    const tool = plugin.tool.devryan_browser;

    await expect(tool.execute({ command: 'connect', args: ['9222'] }, context()))
      .rejects.toThrow('managed by DevRyan');
    await expect(tool.execute({ command: 'open', args: ['https://example.com', '--profile=Default'] }, context()))
      .rejects.toThrow('--profile');
    await expect(tool.execute({ command: 'close', args: ['--all'] }, context()))
      .rejects.toThrow('close --all');
    for (const command of ['batch', 'upgrade', 'doctor', 'mcp', 'dashboard', 'plugin', 'auth', 'stream', 'chat', 'quit', 'exit']) {
      await expect(tool.execute({ command }, context())).rejects.toThrow('managed by DevRyan');
    }
    await expect(tool.execute({ command: 'unknown-command' }, context()))
      .rejects.toThrow('not available through DevRyan browser leases');
    await expect(tool.execute({ command: 'inspect' }, context()))
      .rejects.toThrow('selector is required');
    for (const flag of ['--auto-connect', '--restore', '--extension', '--proxy', '--engine', '--action-policy', '--idle-timeout', '-p']) {
      await expect(tool.execute({ command: 'open', args: ['https://example.com', flag] }, context()))
        .rejects.toThrow('managed by DevRyan');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('single-flights the first daemon connection for concurrent commands in one reuse scope', async () => {
    stubLeaseFetch();
    let releaseConnect;
    const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
    const calls = [];
    const spawnImpl = vi.fn((binary, args) => {
      calls.push({ binary, args });
      if (!args.includes('connect')) return makeChild({ stdout: 'done\n' });
      const child = makeChild({ close: false });
      void connectGate.then(() => child.emit('close', 0));
      return child;
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    const first = plugin.tool.devryan_browser.execute({ command: 'open', args: ['https://example.com'] }, context());
    const second = plugin.tool.devryan_browser.execute({ command: 'snapshot' }, context());

    await vi.waitFor(() => expect(calls.filter((call) => call.args.includes('connect'))).toHaveLength(1));
    releaseConnect();
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
    expect(calls.filter((call) => call.args.includes('connect'))).toHaveLength(1);
  });

  it('bounds settled connection bookkeeping with least-recently-used eviction', async () => {
    stubLeaseFetch();
    const calls = [];
    const spawnImpl = vi.fn((binary, args) => {
      calls.push({ binary, args });
      return makeChild();
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    const limit = __test.MAX_CONNECTION_ENTRIES;

    for (let index = 0; index <= limit; index += 1) {
      await plugin.tool.devryan_browser.execute(
        { command: 'snapshot' },
        context({ messageID: `msg_${index}` }),
      );
    }
    await plugin.tool.devryan_browser.execute(
      { command: 'snapshot' },
      context({ messageID: 'msg_0' }),
    );

    expect(calls.filter((call) => call.args.includes('connect'))).toHaveLength(limit + 2);
  });

  it('fails closed when the installer-owned empty config is missing or modified', async () => {
    rmSync(managedConfigPath, { force: true });
    await expect(DevRyanBrowserPlugin()).rejects.toThrow('managed agent browser config is unavailable');
    writeFileSync(managedConfigPath, '{"provider":"external"}\n', 'utf8');
    await expect(DevRyanBrowserPlugin()).rejects.toThrow('managed agent browser config is unavailable');
  });

  it('caps output while draining and redacts the private lease endpoint', async () => {
    stubLeaseFetch();
    let callIndex = 0;
    const spawnImpl = vi.fn(() => {
      callIndex += 1;
      return callIndex === 1
        ? makeChild()
        : makeChild({
          stdout: `ws://127.0.0.1:54321/devtools/page/private-capability\n${'x'.repeat(70_000)}`,
        });
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    const result = await plugin.tool.devryan_browser.execute({ command: 'snapshot' }, context());
    expect(result).toContain('<redacted>');
    expect(result).toContain('[output truncated at 65536 bytes]');
    expect(result).not.toContain('private-capability');
    expect(Buffer.byteLength(result)).toBeLessThan(66_000);
  });

  it('honors the command timeout and abort signal', async () => {
    stubLeaseFetch();
    let callIndex = 0;
    const spawnImpl = vi.fn(() => {
      callIndex += 1;
      return callIndex === 1 ? makeChild() : makeChild({ close: false });
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute({
      command: 'snapshot',
      timeout_ms: 5,
    }, context())).rejects.toThrow('timed out after 5 ms');
    expect(spawnImpl.mock.results[1].value.kill).toHaveBeenCalled();

    const controller = new AbortController();
    callIndex = 0;
    const nextPlugin = await DevRyanBrowserPlugin({ spawnImpl });
    const pending = nextPlugin.tool.devryan_browser.execute(
      { command: 'snapshot', timeout_ms: 1_000 },
      context({ messageID: 'msg_abort', abort: controller.signal }),
    );
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(4));
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('escalates from SIGTERM to SIGKILL when a timed-out child ignores termination', async () => {
    vi.useFakeTimers();
    const child = makeChild({ close: false });
    const pending = __test.runBinary({
      binaryPath: managedBinaryPath,
      args: ['snapshot'],
      timeoutMs: 5,
      signal: new AbortController().signal,
      spawnImpl: () => child,
      sensitiveValues: [],
    });
    const rejection = expect(pending).rejects.toThrow('timed out after 5 ms');
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('releases a newly created lease when the initial connection fails', async () => {
    const requests = stubLeaseFetch();
    const plugin = await DevRyanBrowserPlugin({
      spawnImpl: () => makeChild({ stderr: 'connect failed', code: 1 }),
    });

    await expect(plugin.tool.devryan_browser.execute({ command: 'snapshot' }, context()))
      .rejects.toThrow('connect failed');
    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      url: 'http://127.0.0.1:45678/api/desktop/browser-leases/dvr_lease_1',
    });
    expect(requests.at(-1).signal.aborted).toBe(false);
  });

  it('releases only its lease on explicit close even when the daemon close fails', async () => {
    const requests = stubLeaseFetch();
    let callIndex = 0;
    const spawnImpl = vi.fn(() => {
      callIndex += 1;
      if (callIndex === 1) return makeChild();
      return makeChild({ stderr: 'close failed', code: 1 });
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });

    await expect(plugin.tool.devryan_browser.execute({ command: 'close' }, context()))
      .rejects.toThrow('close failed');
    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      url: 'http://127.0.0.1:45678/api/desktop/browser-leases/dvr_lease_1',
      body: expect.objectContaining({ opencodeSessionID: 'ses_child' }),
    });
  });

  it('uses a fresh cleanup signal when close is aborted', async () => {
    const requests = stubLeaseFetch();
    const controller = new AbortController();
    let callIndex = 0;
    const spawnImpl = vi.fn(() => {
      callIndex += 1;
      if (callIndex === 1) return makeChild();
      const child = makeChild({ close: false });
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      });
      return child;
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    const pending = plugin.tool.devryan_browser.execute(
      { command: 'close' },
      context({ abort: controller.signal }),
    );
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).rejects.toThrow('aborted');
    expect(requests.at(-1).method).toBe('DELETE');
    expect(requests.at(-1).signal.aborted).toBe(false);
  });

  it('does not expose private bearer or binary values in server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: `private-token at ${managedBinaryPath}` },
    }), { status: 503, headers: { 'content-type': 'application/json' } })));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl: vi.fn() });

    await expect(plugin.tool.devryan_browser.execute({ command: 'snapshot' }, context()))
      .rejects.toThrow('<redacted> at <redacted>');
  });
});

describe('safe browser inspection', () => {
  const inspection = {
    selector: '[role="tooltip"]',
    styles: ['animation-duration', '--accent'],
    attributes: ['data-state', 'aria-label'],
  };
  const found = {
    status: 'found', selector: inspection.selector, matchCount: 1,
    styles: { 'animation-duration': '0.15s', '--accent': 'teal' },
    attributes: { 'data-state': 'open', 'aria-label': null },
  };

  it.each([
    { command: 'inspect' },
    { command: 'inspect', selector: ' ' },
    { command: 'inspect', selector: 12 },
    { command: 'inspect', selector: 'a\0b' },
    { command: 'inspect', selector: 'x'.repeat(8193) },
    { command: 'inspect', selector: '#x', args: ['--json'] },
    { command: 'inspect', selector: '#x', styles: 'display' },
    { command: 'inspect', selector: '#x', styles: [''] },
    { command: 'inspect', selector: '#x', styles: Array(65).fill('display') },
    { command: 'inspect', selector: '#x', attributes: [false] },
    { command: 'inspect', selector: '#x', attributes: ['x'.repeat(8190)] },
    { command: 'snapshot', selector: '#x' },
    { command: 'eval', args: ['document.title'], styles: [] },
    { command: 'close', attributes: null },
  ])('rejects invalid inspection input before acquiring a lease (case %#)', async (input) => {
    const requests = stubLeaseFetch();
    const spawnImpl = vi.fn();
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute(input, context()))
      .rejects.toMatchObject({ code: 'DEVRYAN_BROWSER_INPUT_INVALID' });
    expect(requests).toEqual([]);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reads present values and safely reports removal or ambiguity on the same lease', async () => {
    const requests = stubLeaseFetch();
    const element = { getAttribute: (name) => found.attributes[name] };
    let matches = [element];
    const querySelectorAll = vi.fn(() => matches);
    const getComputedStyle = vi.fn(() => ({ getPropertyValue: (name) => found.styles[name] }));
    const spawnImpl = vi.fn((binary, args) => {
      if (args.includes('connect')) return makeChild();
      expect(args.at(-2)).toBe('eval');
      const result = runInNewContext(args.at(-1), { document: { querySelectorAll }, getComputedStyle });
      return makeChild({ stdout: JSON.stringify(result) });
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    const execute = () => plugin.tool.devryan_browser.execute({ command: 'inspect', ...inspection }, context());
    expect(JSON.parse(await execute())).toEqual(found);
    matches = [];
    expect(JSON.parse(await execute())).toEqual({
      status: 'missing', selector: inspection.selector, matchCount: 0, styles: {}, attributes: {},
    });
    matches = [element, element];
    expect(JSON.parse(await execute())).toEqual({
      status: 'ambiguous', selector: inspection.selector, matchCount: 2, styles: {}, attributes: {},
    });
    expect(getComputedStyle).toHaveBeenCalledTimes(1);
    expect(querySelectorAll.mock.calls).toEqual(Array(3).fill([inspection.selector]));
    expect(spawnImpl.mock.calls.filter(([, args]) => args.includes('connect'))).toHaveLength(1);
    expect(requests.filter((entry) => entry.url.endsWith('/touch'))).toHaveLength(6);
    expect(requests.filter((entry) => entry.method === 'DELETE')).toHaveLength(0);
  });

  it('defaults lists to empty and serializes quotes and source-like text as data', () => {
    const selector = '[data-label="quoted\\\"value"]; throw new Error("injected")';
    const normalized = __test.normalizeInspection('inspect', [], { selector });
    const querySelectorAll = vi.fn(() => [{ getAttribute: vi.fn() }]);
    const getComputedStyle = vi.fn();
    const result = runInNewContext(__test.buildBrowserInspectionScript(normalized), {
      document: { querySelectorAll }, getComputedStyle,
    });
    expect(querySelectorAll).toHaveBeenCalledExactlyOnceWith(selector);
    expect(result).toEqual({ status: 'found', selector, matchCount: 1, styles: {}, attributes: {} });
    expect(getComputedStyle).not.toHaveBeenCalled();
  });

  it('deduplicates requested names and preserves special map keys as own properties', () => {
    const normalized = __test.normalizeInspection('inspect', [], {
      selector: '#x', styles: ['--accent', '--accent'], attributes: ['__proto__', 'constructor'],
    });
    expect(normalized.styles).toEqual(['--accent']);
    const output = runInNewContext(__test.buildBrowserInspectionScript(normalized), {
      document: { querySelectorAll: () => [{ getAttribute: () => null }] },
      getComputedStyle: () => ({ getPropertyValue: () => 'teal' }),
    });
    expect(__test.parseBrowserInspectionResult(JSON.stringify(output), normalized).attributes)
      .toEqual(JSON.parse('{"__proto__":null,"constructor":null}'));
  });

  it('maps only invalid CSS selectors to an input error and still touches the lease', async () => {
    const requests = stubLeaseFetch();
    const spawnImpl = vi.fn((binary, args) => {
      if (args.includes('connect')) return makeChild();
      const result = runInNewContext(args.at(-1), {
        document: { querySelectorAll: () => { throw new DOMException('Invalid selector', 'SyntaxError'); } },
      });
      return makeChild({ stdout: JSON.stringify(result) });
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute({ command: 'inspect', selector: '[' }, context()))
      .rejects.toMatchObject({ code: 'DEVRYAN_BROWSER_INPUT_INVALID' });
    expect(requests.filter((entry) => entry.url.endsWith('/touch'))).toHaveLength(2);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('does not mask unexpected errors from its fixed inspection script', async () => {
    stubLeaseFetch();
    const failure = '✗ Evaluation error: TypeError: Invalid input in inspector internals';
    const spawnImpl = vi.fn((binary, args) => args.includes('connect')
      ? makeChild() : makeChild({ stderr: failure, code: 1 }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute({ command: 'inspect', ...inspection }, context()))
      .rejects.toMatchObject({ code: 'DEVRYAN_BROWSER_INSPECTION_FAILED', message: expect.stringContaining(failure) });
    expect(() => runInNewContext(__test.buildBrowserInspectionScript(inspection), {
      document: { querySelectorAll: () => { throw new TypeError('query failed'); } },
    })).toThrow('query failed');
  });

  it.each([
    'not JSON',
    '{}',
    'null',
    JSON.stringify({ ...found, status: 'missing' }),
    JSON.stringify({ ...found, matchCount: 2 }),
    JSON.stringify({ ...found, selector: '#different' }),
    JSON.stringify({ ...found, styles: { 'animation-duration': 0.15, '--accent': 'teal' } }),
    JSON.stringify({ ...found, attributes: {} }),
    JSON.stringify({ error: 'invalid_selector', unexpected: true }),
  ])('rejects invalid inspector output as a runtime failure: %s', (output) => {
    expect(() => __test.parseBrowserInspectionResult(output, inspection))
      .toThrow('DEVRYAN_BROWSER_INSPECTION_FAILED');
  });

  it('keeps sanitized result values and rejects truncated results without claiming success', async () => {
    stubLeaseFetch();
    let output = JSON.stringify({ ...found, attributes: { 'data-state': 'private-token', 'aria-label': null } });
    const spawnImpl = vi.fn((binary, args) => args.includes('connect') ? makeChild() : makeChild({ stdout: output }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    expect(JSON.parse(await plugin.tool.devryan_browser.execute({ command: 'inspect', ...inspection }, context()))
      .attributes['data-state']).toBe('<redacted>');
    output = JSON.stringify({ ...found, attributes: { 'data-state': 'x'.repeat(70000), 'aria-label': null } });
    await expect(plugin.tool.devryan_browser.execute({ command: 'inspect', ...inspection }, context()))
      .rejects.toMatchObject({ code: 'DEVRYAN_BROWSER_INSPECTION_FAILED', message: expect.stringContaining('truncated') });
  });

  it('compares redacted selector identity without exposing the private value', () => {
    const request = { selector: '[data-id="private-token"]', styles: [], attributes: [] };
    const output = JSON.stringify({
      status: 'missing', selector: '[data-id="<redacted>"]', matchCount: 0, styles: {}, attributes: {},
    });
    expect(__test.parseBrowserInspectionResult(output, request, ['private-token']).selector)
      .toBe('[data-id="<redacted>"]');
  });
});

describe('caller eval error boundary', () => {
  it.each([
    [{ command: 'eval', args: ['getComputedStyle(null)'] },
      { stderr: '✗ Evaluation error: TypeError: missing tooltip', code: 1 }, 'DEVRYAN_BROWSER_EVAL_ERROR'],
    [{ command: 'inspect', selector: '[' },
      { stdout: '{"error":"invalid_selector"}' }, 'DEVRYAN_BROWSER_INPUT_INVALID'],
  ])('preserves a final lease failure over an expected caller error (case %#)', async (input, childResult, inputCode) => {
    stubLeaseFetch();
    const fetchLease = fetch;
    let touches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/touch') && ++touches === 2) {
        return new Response(JSON.stringify({ error: { message: 'lease host unavailable private-token' } }), { status: 503 });
      }
      return fetchLease(url, init);
    }));
    const spawnImpl = vi.fn((binary, args) => args.includes('connect') ? makeChild() : makeChild(childResult));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    let failure;
    try { await plugin.tool.devryan_browser.execute(input, context()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED' });
    expect(failure.message).toContain('lease host unavailable <redacted>');
    expect(failure.message).toContain(`Browser command also failed: ${inputCode}:`);
    expect(failure.message).not.toContain('private-token');
    expect(touches).toBe(2);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['TypeError', 'ReferenceError', 'SyntaxError'])('identifies explicit %s exceptions, retaining failure and safe guidance', async (name) => {
    const requests = stubLeaseFetch();
    const failure = `✗ Evaluation error: ${name}: private-token is not an Element`;
    const spawnImpl = vi.fn((binary, args) => args.includes('connect') ? makeChild() : makeChild({ stderr: failure, code: 1 }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute({ command: 'eval', args: ['getComputedStyle(null)'] }, context()))
      .rejects.toMatchObject({
        code: 'DEVRYAN_BROWSER_EVAL_ERROR',
        message: expect.stringContaining(`${name}: <redacted> is not an Element`),
      });
    expect(requests.filter((entry) => entry.url.endsWith('/touch'))).toHaveLength(2);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    'ECONNREFUSED: unable to connect',
    'Error: page has closed',
    '✗ Evaluation error: Error: unexplained failure',
    'transport failed: ✗ Evaluation error: TypeError: disconnected',
  ])('does not downgrade other eval command failures: %s', async (failure) => {
    stubLeaseFetch();
    const spawnImpl = vi.fn((binary, args) => args.includes('connect') ? makeChild() : makeChild({ stderr: failure, code: 1 }));
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute({ command: 'eval', args: ['document.title'] }, context()))
      .rejects.toMatchObject({ code: 'DEVRYAN_BROWSER_COMMAND_FAILED' });
  });

  it('does not classify process start failures as caller JavaScript errors', async () => {
    stubLeaseFetch();
    const spawnImpl = vi.fn((binary, args) => {
      if (args.includes('connect')) return makeChild();
      throw new TypeError('✗ Evaluation error: TypeError: process unavailable');
    });
    const plugin = await DevRyanBrowserPlugin({ spawnImpl });
    await expect(plugin.tool.devryan_browser.execute({ command: 'eval', args: ['document.title'] }, context()))
      .rejects.toMatchObject({ code: 'DEVRYAN_BROWSER_COMMAND_FAILED' });
  });
});

describe('eval snippet wrapping', () => {
  it('wraps a snippet using top-level await', () => {
    // "SyntaxError: await is only valid in async functions and the top level
    // bodies of modules" — observed 2026-08-21 00:19:03.
    const wrapped = wrapBrowserEvalSnippet('await fetch("/api/health").then(r => r.status)');
    expect(wrapped).toBe('(async () => { await fetch("/api/health").then(r => r.status) })()');
  });

  it('wraps a snippet using a top-level return', () => {
    // "SyntaxError: Illegal return statement" — observed 2026-08-21 00:19:22.
    const wrapped = wrapBrowserEvalSnippet('const el = document.querySelector("#x"); return el.textContent;');
    expect(wrapped).toBe('(async () => { const el = document.querySelector("#x"); return el.textContent; })()');
  });

  it('leaves a plain expression untouched', () => {
    expect(wrapBrowserEvalSnippet('document.title')).toBe('document.title');
    expect(wrapBrowserEvalSnippet('document.querySelectorAll("a").length')).toBe('document.querySelectorAll("a").length');
  });

  it('does not treat a property named await or return as a keyword', () => {
    expect(wrapBrowserEvalSnippet('x.return v')).toBe('x.return v');
    expect(wrapBrowserEvalSnippet('obj.await thing')).toBe('obj.await thing');
  });

  it('does not double-wrap an already-wrapped snippet', () => {
    const snippet = '(async () => { await go(); })()';
    expect(wrapBrowserEvalSnippet(snippet)).toBe(snippet);
  });

  it('leaves non-strings and blanks alone', () => {
    expect(wrapBrowserEvalSnippet('')).toBe('');
    expect(wrapBrowserEvalSnippet(undefined)).toBe(undefined);
  });
});
