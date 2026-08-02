import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const { DevRyanBrowserPlugin, __test } = browserPluginModule;

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

const stubLeaseFetch = ({ wsUrl = 'ws://127.0.0.1:54321/devtools/page/private-capability' } = {}) => {
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
    if (request.method === 'POST' && request.url.endsWith('/api/desktop/browser-leases')) {
      return new Response(JSON.stringify({
        leaseId: 'dvr_lease_1',
        wsUrl,
        created: requests.filter((entry) => entry.url.endsWith('/api/desktop/browser-leases')).length === 1,
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
      .rejects.toThrow('not available through DevRyan browser leases');
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
