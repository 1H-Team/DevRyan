import { describe, expect, it, vi } from 'vitest';

import { createAgentRuntimeWarmup } from './agent-runtime-warmup.js';

describe('agent runtime warmup', () => {
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
      'GET /health',
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
