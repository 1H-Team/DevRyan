import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
  DevRyanToolInputGuardPlugin,
} from './devryan-tool-input-guard.mjs';

const { afterEach, describe, expect, test } = process.env.VITEST
  ? await import('vitest')
  : await import('bun:test');

const beforeTool = async (tool, args) => {
  const hooks = await DevRyanToolInputGuardPlugin();
  return hooks['tool.execute.before'](
    { tool, sessionID: 'session-1', callID: 'call-1' },
    { args },
  );
};

afterEach(() => {
  delete globalThis.__DEVRYAN_GUARD_EXECUTED__;
});

describe('DevRyan tool input guard plugin', () => {
  test('allows one grep path, including a path containing spaces', async () => {
    await expect(beforeTool('grep', { path: '/tmp/Project With Spaces/src' })).resolves.toBeUndefined();
  });

  test('rejects multiple absolute targets in one grep path', async () => {
    await expect(beforeTool('grep', {
      path: '/tmp/project/src/components /tmp/project/src/pages /tmp/project/src/App.tsx',
    })).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      message: expect.stringContaining('grep.path accepts exactly one path'),
    });
    await expect(beforeTool('grep', {
      path: '"/tmp/project one/src" "/tmp/project two/src"',
    })).rejects.toMatchObject({ code: 'DEVRYAN_TOOL_INPUT_INVALID' });
  });

  test.each([
    undefined,
    {},
    { path: null },
    { path: '' },
    { path: '   ' },
  ])('rejects read input without a non-empty string path: %j', async (args) => {
    await expect(beforeTool('read', args)).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      message: expect.stringContaining('read.path must be a non-empty string'),
    });
  });

  test('allows a valid read path', async () => {
    await expect(beforeTool('read', { path: '/tmp/project/file.ts' })).resolves.toBeUndefined();
  });

  test('allows valid JavaScript without executing it', async () => {
    await expect(beforeTool('ctx_execute', {
      language: 'javascript',
      code: 'globalThis.__DEVRYAN_GUARD_EXECUTED__ = true; await Promise.resolve();',
    })).resolves.toBeUndefined();
    expect(globalThis.__DEVRYAN_GUARD_EXECUTED__).toBeUndefined();
  });

  test('rejects malformed JavaScript with the stable input code', async () => {
    await expect(beforeTool('ctx_execute', {
      language: 'javascript',
      code: 'for (const item of items) { console.log(item);',
    })).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      message: expect.stringContaining('ctx_execute JavaScript must parse before execution'),
    });
  });

  test('passes through non-JavaScript snippets', async () => {
    await expect(beforeTool('ctx_execute', {
      language: 'python',
      code: 'for item in items:\n    print(item)',
    })).resolves.toBeUndefined();
  });

  test('rejects static module declarations that are invalid function-body scripts', async () => {
    await expect(beforeTool('mcp__context_mode__ctx_execute', {
      language: 'javascript',
      code: "import fs from 'node:fs';\nconsole.log(fs);",
    })).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      message: expect.stringContaining('ctx_execute JavaScript must parse before execution'),
    });
  });

  test.each(['bash', 'shell'])('adds the default deadline to %s', async (tool) => {
    const args = { command: 'pwd' };
    await expect(beforeTool(tool, args)).resolves.toBeUndefined();
    expect(args).toMatchObject({ timeout: DEFAULT_SHELL_TIMEOUT_MS });
  });

  test('preserves a valid explicit shell deadline', async () => {
    const args = { command: 'bun test', timeout: 900_000 };
    await expect(beforeTool('bash', args)).resolves.toBeUndefined();
    expect(args).toMatchObject({ timeout: 900_000 });
  });

  test.each([999, MAX_SHELL_TIMEOUT_MS + 1, 2_000.5, '240000', null])(
    'rejects an invalid shell deadline: %j',
    async (timeout) => {
      await expect(beforeTool('bash', { command: 'pwd', timeout })).rejects.toMatchObject({
        code: 'DEVRYAN_TOOL_INPUT_INVALID',
        message: expect.stringContaining('shell timeout must be an integer'),
      });
    },
  );

  test('does not affect unrelated tools', async () => {
    const args = { command: 'pwd' };
    await expect(beforeTool('custom_tool', args)).resolves.toBeUndefined();
    expect(args).not.toHaveProperty('timeout');
  });
});
