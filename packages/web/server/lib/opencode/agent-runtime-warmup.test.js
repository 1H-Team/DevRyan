import { createNativeConsumerFixture } from './test-native-consumer-client.js';
const createAgentRuntimeWarmup = (options = {}) => createAgentRuntimeWarmupNative({
  ...options, openCodeClient: options.openCodeClient ?? createNativeConsumerFixture({
    readFixture: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)), headers: options.getOpenCodeAuthHeaders,
  }),
});
import { describe, expect, it, vi } from 'vitest';

import { createAgentRuntimeWarmup as createAgentRuntimeWarmupNative } from './agent-runtime-warmup.js';

describe('agent runtime warmup', () => {
  it('checkpoint waits timed-out task and ledger settlement and refuses new warmup', async () => {
    let releaseTask, releaseLedger;
    const pendingTask = new Promise(resolve => { releaseTask = resolve; });
    const pendingLedger = new Promise(resolve => { releaseLedger = resolve; });
    const warmup = createAgentRuntimeWarmup({ fetchImpl: async () => Response.json({ ok: true }),
      warmXaiToolCatalog: () => pendingTask, warmLedger: () => pendingLedger });
    await warmup.warm({ directory: '/fixture', timeoutMs: 10, commandTimeoutMs: 10, mcpTimeoutMs: 10, xaiTimeoutMs: 1 });
    let drained = false;
    const drain = warmup.holdForCheckpoint().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    await expect(warmup.warm({ directory: '/later' })).rejects.toMatchObject({ code: 'bundle_warmup_held' });
    releaseTask(); await Promise.resolve(); expect(drained).toBe(false);
    releaseLedger(); await drain; expect(drained).toBe(true);
    expect(warmup.holdForCheckpoint()).toBe(warmup.holdForCheckpoint());
  });

  it('runs only safe read-only startup tasks', async () => {
    const requested = [];
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      fetchImpl: vi.fn(async (url, options) => {
        requested.push({ url: String(url), method: options?.method ?? 'GET' });
        if (String(url).endsWith('/config/providers?directory=%2Fproject')) {
          return Response.json({ providers: [], default: {} });
        }
        if (String(url).endsWith('/agent?directory=%2Fproject')) {
          return Response.json([]);
        }
        if (String(url).endsWith('/session/status?directory=%2Fproject')) {
          return Response.json({});
        }
        return Response.json({ ok: true });
      }),
      discoverSkills: () => [
        { name: 'using-superpowers', path: '/skills/using-superpowers/SKILL.md' },
        { name: 'other', path: '/skills/other/SKILL.md' },
      ],
      readSkillFile: vi.fn(() => 'skill content'),
      now: () => 1_000,
    });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(result.status).toBe('ready');
    expect(result.timedOut).toBe(false);
    expect(result.tasks.map((task) => task.name)).toEqual([
      'health',
      'config',
      'providers',
      'agents',
      'sessionStatus',
      'opencodeSkills',
      'mcp',
      'commands',
      'skills',
    ]);
    expect(requested.map((entry) => {
      const url = new URL(entry.url);
      return `${entry.method} ${url.pathname}${url.search}`;
    })).toEqual([
      'GET /global/health',
      'GET /config?directory=%2Fproject',
      'GET /config/providers?directory=%2Fproject',
      'GET /agent?directory=%2Fproject',
      'GET /session/status?directory=%2Fproject',
      'GET /skill?directory=%2Fproject',
      'GET /mcp?directory=%2Fproject',
      'GET /command?directory=%2Fproject',
    ]);
    expect(requested.some((entry) => /prompt|prompt_async/.test(entry.url))).toBe(false);
    expect(requested.some((entry) => entry.method !== 'GET')).toBe(false);
  });

  it('prewarms Cursor SDK runtime when the host provides a warmup hook', async () => {
    const cursorPrewarm = vi.fn(async () => ({ ok: true }));
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async () => Response.json({})),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      cursorPrewarm,
      now: () => 1_000,
    });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(cursorPrewarm).toHaveBeenCalledOnce();
    expect(cursorPrewarm).toHaveBeenCalledWith({ directory: '/project' });
    expect(result.tasks.find((task) => task.name === 'cursorSdk')).toEqual(expect.objectContaining({
      name: 'cursorSdk',
      status: 'ready',
    }));
  });

  it('starts a background ledger build without waiting for it, unless the caller opts out', async () => {
    let finish;
    const warmLedger = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const create = () => createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async () => Response.json({})),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      warmLedger,
      now: () => 1_000,
    });

    const result = await create().warm({ directory: '/project', timeoutMs: 1_000 });
    expect(warmLedger).toHaveBeenCalledWith({ directory: '/project' });
    // The warmup finished while the ledger build is still pending.
    expect(result.tasks.some((task) => task.name === 'ledger')).toBe(false);
    finish({ built: true });

    await create().warm({ directory: '/other', ledger: false, timeoutMs: 1_000 });
    expect(warmLedger).toHaveBeenCalledTimes(1);

    const failing = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl: vi.fn(async () => Response.json({})),
      warmLedger: () => { throw new Error('boom'); },
      now: () => 1_000,
    });
    await expect(failing.warm({ directory: '/project', timeoutMs: 1_000 })).resolves.toBeTruthy();
  });

  it('prewarms the Grok tool catalog without creating a prompt', async () => {
    const warmXaiToolCatalog = vi.fn(async () => true);
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async () => Response.json({})),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      warmXaiToolCatalog,
      now: () => 1_000,
    });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(warmXaiToolCatalog).toHaveBeenCalledWith({
      directory: '/project',
      signal: expect.anything(),
    });
    expect(result.tasks.map((task) => task.name)).toEqual([
      'health',
      'config',
      'providers',
      'agents',
      'sessionStatus',
      'opencodeSkills',
      'xaiTools',
      'mcp',
      'commands',
      'skills',
    ]);
  });

  it('gives the Grok tool-catalog warm its own budget beyond the core timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveWarm;
      const warmXaiToolCatalog = vi.fn(() => new Promise((resolve) => { resolveWarm = resolve; }));
      const warmup = createAgentRuntimeWarmup({
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: vi.fn(async () => Response.json({})),
        discoverSkills: () => [],
        readSkillFile: vi.fn(),
        warmXaiToolCatalog,
      });

      const warmPromise = warmup.warm({ directory: '/project', timeoutMs: 1_000 });
      // Past the core budget but inside the xai budget: the warm must survive.
      await vi.advanceTimersByTimeAsync(8_000);
      resolveWarm(true);
      const result = await warmPromise;

      const xaiTask = result.tasks.find((task) => task.name === 'xaiTools');
      expect(xaiTask).toEqual(expect.objectContaining({ name: 'xaiTools', status: 'ready' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the Grok tool-catalog warm when its own budget elapses', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal;
      const warmXaiToolCatalog = vi.fn(({ signal }) => {
        observedSignal = signal;
        return new Promise(() => {});
      });
      const warmup = createAgentRuntimeWarmup({
        buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: vi.fn(async () => Response.json({})),
        discoverSkills: () => [],
        readSkillFile: vi.fn(),
        warmXaiToolCatalog,
      });

      const warmPromise = warmup.warm({ directory: '/project', timeoutMs: 1_000, xaiTimeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await warmPromise;

      const xaiTask = result.tasks.find((task) => task.name === 'xaiTools');
      expect(xaiTask).toEqual(expect.objectContaining({ name: 'xaiTools', status: 'timeout' }));
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warms only skills returned by the approved-skill resolver', async () => {
    const readSkillFile = vi.fn(() => 'skill content');
    const resolveApprovedSkills = vi.fn(() => [
      { name: 'accessibility', path: '/repo/.agents/skills/accessibility/SKILL.md' },
    ]);
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async () => Response.json({})),
      discoverSkills: () => [
        { name: 'accessibility', path: '/repo/.agents/skills/accessibility/SKILL.md' },
        { name: 'untrusted', path: '/repo/.cursor/skills/untrusted/SKILL.md' },
      ],
      getHiddenSkills: () => [{ name: 'hidden', path: '/skills/hidden/SKILL.md' }],
      resolveApprovedSkills,
      readSkillFile,
      now: () => 1_000,
    });

    await warmup.warm({ directory: '/repo', timeoutMs: 1_000 });

    expect(resolveApprovedSkills).toHaveBeenCalledWith({
      discoveredSkills: expect.any(Array),
      hiddenSkills: [{ name: 'hidden', path: '/skills/hidden/SKILL.md' }],
    });
    expect(readSkillFile).toHaveBeenCalledOnce();
    expect(readSkillFile).toHaveBeenCalledWith('/repo/.agents/skills/accessibility/SKILL.md');
  });

  it('returns per-task errors without failing the whole warmup', async () => {
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes('/agent?')) {
          throw new Error('agent fetch failed');
        }
        return Response.json({});
      }),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      now: () => 1_000,
    });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(result.status).toBe('ready');
    expect(result.tasks.find((task) => task.name === 'agents')).toEqual(expect.objectContaining({
      status: 'error',
      error: 'agent fetch failed',
    }));
  });

  it('persists the latest warmup diagnostics with timestamp, directory, errors, and timeout state', async () => {
    let currentTime = 10_000;
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes('/agent?')) {
          throw new Error('agent fetch failed');
        }
        return Response.json({});
      }),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      now: () => currentTime,
    });

    currentTime = 11_000;
    const result = await warmup.warm({ directory: '/project', timeoutMs: 1_000 });
    const latest = warmup.getLatestResult();

    expect(latest).toEqual(expect.objectContaining({
      timestamp: 11_000,
      directory: '/project',
      timedOut: false,
      status: 'ready',
    }));
    expect(latest.tasks).toEqual(result.tasks);
    expect(latest.errors).toEqual([
      { name: 'agents', status: 'error', error: 'agent fetch failed' },
    ]);
    expect(latest.harness).toEqual(expect.objectContaining({
      status: 'warning',
      summary: expect.stringContaining('completed with 1 issue'),
    }));
  });

  it('caps warmup time and reports a timeout', async () => {
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(() => new Promise(() => {})),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      now: () => Date.now(),
    });

    const result = await warmup.warm({
      directory: '/project',
      timeoutMs: 1,
      commandTimeoutMs: 1,
      mcpTimeoutMs: 1,
    });

    expect(result.status).toBe('ready');
    expect(result.timedOut).toBe(true);
    expect(result.tasks.some((task) => task.status === 'timeout')).toBe(true);
  });

  it('allows command discovery to outlive the short general warmup timeout', async () => {
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes('/command?')) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return Response.json({});
      }),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      now: () => Date.now(),
    });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1, commandTimeoutMs: 50 });

    expect(result.tasks.find((task) => task.name === 'commands')).toEqual(expect.objectContaining({
      status: 'ready',
    }));
  });

  it('allows MCP status to outlive the short general warmup timeout', async () => {
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes('/mcp?')) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return Response.json({});
      }),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      now: () => Date.now(),
    });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1, mcpTimeoutMs: 50 });

    expect(result.tasks.find((task) => task.name === 'mcp')).toEqual(expect.objectContaining({
      status: 'ready',
    }));
  });

  it('runs MCP status and command discovery concurrently', async () => {
    const events = [];
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes('/mcp?')) {
          events.push('mcp-start');
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push('mcp-end');
        }
        if (String(url).includes('/command?')) {
          events.push('command-start');
        }
        return Response.json({});
      }),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
      now: () => Date.now(),
    });

    await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(events.indexOf('mcp-end')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('command-start')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('command-start')).toBeLessThan(events.indexOf('mcp-end'));
  });

  it('shares one in-flight warmup for concurrent calls to the same directory', async () => {
    let releaseFetch;
    const fetchGate = new Promise((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await fetchGate;
      return Response.json({});
    });
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
    });

    const first = warmup.warm({ directory: ' /project ', timeoutMs: 1_000 });
    const second = warmup.warm({ directory: '/project', timeoutMs: 5_000 });

    expect(second).toBe(first);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
  });

  it('allows different directories to warm concurrently', async () => {
    const mcpStarts = [];
    let releaseMcp;
    const mcpGate = new Promise((resolve) => {
      releaseMcp = resolve;
    });
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes('/mcp?')) {
          mcpStarts.push(new URL(String(url)).searchParams.get('directory'));
          await mcpGate;
        }
        return Response.json({});
      }),
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
    });

    const first = warmup.warm({ directory: '/project-a', timeoutMs: 1_000 });
    const second = warmup.warm({ directory: '/project-b', timeoutMs: 1_000 });

    await Promise.resolve();
    expect(mcpStarts).toEqual(['/project-a', '/project-b']);
    releaseMcp();
    await Promise.all([first, second]);
  });

  it('executes a new warmup after the previous call settles', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const warmup = createAgentRuntimeWarmup({
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      discoverSkills: () => [],
      readSkillFile: vi.fn(),
    });

    await warmup.warm({ directory: '/project', timeoutMs: 1_000 });
    await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(fetchImpl).toHaveBeenCalledTimes(16);
  });
});

describe('agent runtime warmup on OpenCode 2', () => {
  const createClient = ({ generation = 2, ready = true } = {}) => {
    const calls = [];
    const record = (name) => vi.fn(async (query, options) => {
      calls.push({ name, query, signal: options?.signal ?? null });
      return name === 'health.probe' ? { ready, reason: ready ? null : 'not_ready', version: '2.0.20' } : [];
    });
    return {
      calls,
      client: {
        generation: () => generation,
        health: { probe: vi.fn(async (options) => record('health.probe')(undefined, options)) },
        sessions: { status: record('sessions.status') },
        catalog: {
          config: record('catalog.config'),
          providers: record('catalog.providers'),
          agents: record('catalog.agents'),
          skills: record('catalog.skills'),
          mcp: record('catalog.mcp'),
          commands: record('catalog.commands'),
        },
      },
    };
  };

  it('runs the same read-only checks through the client', async () => {
    const { client, calls } = createClient();
    const fetchImpl = vi.fn();
    const warmup = createAgentRuntimeWarmup({ openCodeClient: () => client, fetchImpl, now: () => 1_000 });

    const result = await warmup.warm({ directory: '/project', timeoutMs: 1_000 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.tasks.map((task) => [task.name, task.status])).toEqual([
      ['health', 'ready'], ['config', 'ready'], ['providers', 'ready'], ['agents', 'ready'], ['sessionStatus', 'ready'],
      ['opencodeSkills', 'ready'], ['mcp', 'ready'], ['commands', 'ready'], ['skills', 'ready'],
    ]);
    expect(calls.map((call) => [call.name, call.query?.directory ?? null])).toEqual([
      ['health.probe', null],
      ['catalog.config', '/project'],
      ['catalog.providers', '/project'],
      ['catalog.agents', '/project'],
      ['sessions.status', '/project'],
      ['catalog.skills', '/project'],
      ['catalog.mcp', '/project'],
      ['catalog.commands', '/project'],
    ]);
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it('skips location-scoped reads without a directory and reports an unready host', async () => {
    const { client, calls } = createClient({ ready: false });
    const warmup = createAgentRuntimeWarmup({ openCodeClient: client, now: () => 1_000 });

    const result = await warmup.warm({ timeoutMs: 1_000 });

    expect(calls.map((call) => call.name)).toEqual(['health.probe', 'sessions.status']);
    expect(result.tasks.find((task) => task.name === 'health')).toMatchObject({ status: 'error', error: 'OpenCode is not ready (not_ready)' });
    expect(result.tasks.filter((task) => task.name !== 'health').every((task) => task.status === 'ready')).toBe(true);
  });

  it('fails every OpenCode check closed on unknown or generation 1 identities', async () => {
    const unknown = { generation: () => { throw new Error('The OpenCode runtime generation is unknown'); } };
    const fetchImpl = vi.fn(async () => Response.json({}));
    const failing = createAgentRuntimeWarmup({ openCodeClient: unknown, fetchImpl, now: () => 1_000 });
    const failed = await failing.warm({ directory: '/project', timeoutMs: 1_000 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failed.tasks.filter((task) => task.name !== 'skills').every((task) => task.status === 'error')).toBe(true);

    const { client, calls } = createClient({ generation: 1 });
    const legacy = createAgentRuntimeWarmup({
      openCodeClient: client, fetchImpl, buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`, now: () => 1_000,
    });
    await legacy.warm({ directory: '/project', timeoutMs: 1_000 });
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
