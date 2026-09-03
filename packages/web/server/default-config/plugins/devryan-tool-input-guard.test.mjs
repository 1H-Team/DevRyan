import { DevRyanToolInputGuardPlugin, __test } from './devryan-tool-input-guard.mjs';

// Constants live on `__test` because OpenCode's plugin loader rejects any module
// with a non-function named export.
const { DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS } = __test;

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

const afterTool = async (hooks, tool, output, args = {}) => {
  const result = { title: '', output, metadata: { source: 'native' } };
  await hooks['tool.execute.after'](
    { tool, sessionID: 'session-1', callID: 'call-1', args },
    result,
  );
  return result;
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

  test.each(['read', 'oc_read'])('rejects known binary paths before %s executes', async (tool) => {
    for (const readPath of [
      '/tmp/project/image.png',
      '/tmp/project/IMAGE.JPEG',
      '/tmp/project/report.pdf',
      '/tmp/project/archive.zip',
      '/tmp/project/font.woff2',
      '/tmp/project/audio.mp3',
      '/tmp/project/video.mp4',
      '/tmp/project/program.exe',
    ]) {
      await expect(beforeTool(tool, { path: readPath })).rejects.toMatchObject({
        code: 'DEVRYAN_TOOL_INPUT_INVALID',
        message: expect.stringContaining('read cannot load binary files'),
      });
    }
  });

  test.each(['read', 'oc_read'])('allows textual paths through %s', async (tool) => {
    for (const readPath of [
      '/tmp/project/file.ts',
      '/tmp/project/README.md',
      '/tmp/project/data.json',
      '/tmp/project/runtime.log',
      '/tmp/project/icon.svg',
      '/tmp/project/extensionless',
    ]) {
      await expect(beforeTool(tool, { path: readPath })).resolves.toBeUndefined();
    }
  });

  test('accepts compatibility read path aliases', async () => {
    await expect(beforeTool('oc_read', { filePath: '/tmp/project/file.ts' })).resolves.toBeUndefined();
  });

  test('removes raw PNG bytes from a completed read result', async () => {
    const hooks = await DevRyanToolInputGuardPlugin();
    const rawPng = '\uFFFDPNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0001w\uFFFD\uFFFD\u0001';

    const result = await afterTool(hooks, 'read', rawPng, { path: '/tmp/project/extensionless' });

    expect(result.output).toContain('DEVRYAN_BINARY_READ_BLOCKED');
    expect(result.output).not.toContain('IHDR');
    expect(result.metadata).toEqual({ source: 'native' });
  });

  test('detects misleadingly named binary output without affecting Unicode text', async () => {
    const hooks = await DevRyanToolInputGuardPlugin();
    const binary = `header${'\uFFFD\u0001'.repeat(40)}`;
    const unicode = 'مرحبا 👋 café\nOne literal replacement character: \uFFFD';

    const [blocked, preserved] = await Promise.all([
      afterTool(hooks, 'oc_read', binary, { path: '/tmp/project/payload.data' }),
      afterTool(hooks, 'read', unicode, { path: '/tmp/project/notes.txt' }),
    ]);

    expect(blocked.output).toContain('DEVRYAN_BINARY_READ_BLOCKED');
    expect(preserved.output).toBe(unicode);
  });

  test('scrubs historical binary read results only in the provider-bound copy', async () => {
    const hooks = await DevRyanToolInputGuardPlugin();
    const canonical = {
      messages: [{
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: '/tmp/project/auth-login.png' },
              output: '\uFFFDPNG\r\n\u001a\nraw bytes',
            },
          },
          {
            type: 'tool',
            tool: 'grep',
            state: { status: 'completed', input: {}, output: 'matching text' },
          },
          {
            type: 'file',
            filename: 'photo.png',
            mime: 'image/png',
            url: 'data:image/png;base64,AQID',
          },
        ],
      }],
    };
    const providerCopy = structuredClone(canonical);

    await hooks['experimental.chat.messages.transform']({}, providerCopy);

    expect(providerCopy.messages[0].parts[0].state.output).toContain('DEVRYAN_BINARY_READ_BLOCKED');
    expect(providerCopy.messages[0].parts[1].state.output).toBe('matching text');
    expect(providerCopy.messages[0].parts[2]).toEqual(canonical.messages[0].parts[2]);
    expect(canonical.messages[0].parts[0].state.output).toContain('raw bytes');
  });

  test('does not change unrelated completed tool results', async () => {
    const hooks = await DevRyanToolInputGuardPlugin();
    const output = '\uFFFDPNG\r\n\u001a\nraw bytes';
    const result = await afterTool(hooks, 'custom_tool', output, { path: '/tmp/project/image.png' });
    expect(result.output).toBe(output);
  });

  test('preserves textual read errors and ANSI logs even for binary-named paths', async () => {
    const hooks = await DevRyanToolInputGuardPlugin();
    const textualError = 'File not found: /tmp/project/missing.png';
    const ansiLog = '\u001b[31merror\u001b[0m: still ordinary text\n'.repeat(20);

    const providerCopy = {
      messages: [{
        parts: [{
          type: 'tool',
          tool: 'read',
          state: {
            input: { path: '/tmp/project/missing.png' },
            output: textualError,
          },
        }],
      }],
    };
    await hooks['experimental.chat.messages.transform']({}, providerCopy);
    const logResult = await afterTool(hooks, 'read', ansiLog, { path: '/tmp/project/runtime.log' });

    expect(providerCopy.messages[0].parts[0].state.output).toBe(textualError);
    expect(logResult.output).toBe(ansiLog);
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

  test.each([
    [1, 1_000],
    [30, 30_000],
    [999, 999_000],
  ])('reads a small shell deadline as seconds: %j -> %j ms', async (timeout, expected) => {
    const args = { command: 'pwd', timeout };
    await expect(beforeTool('bash', args)).resolves.toBeUndefined();
    expect(args).toMatchObject({ timeout: expected });
  });

  test.each([1_000, 3_601, MAX_SHELL_TIMEOUT_MS])(
    'keeps a deadline at or above the millisecond floor as milliseconds: %j',
    async (timeout) => {
      const args = { command: 'pwd', timeout };
      await expect(beforeTool('bash', args)).resolves.toBeUndefined();
      expect(args).toMatchObject({ timeout });
    },
  );

  test.each([0, -1, MAX_SHELL_TIMEOUT_MS + 1, 2_000.5, 999.5, '240000', '30', null])(
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
