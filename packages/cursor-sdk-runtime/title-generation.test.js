import { describe, expect, test } from 'bun:test';

import { createCursorSdkRuntime } from './index.js';

describe('Cursor SDK session title generation', () => {
  test('uses an ephemeral Cursor Auto prompt and normalizes the returned title', async () => {
    const promptCalls = [];
    const runtime = createCursorSdkRuntime({
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      loadSdk: async () => ({
        Agent: {
          prompt: async (message, options) => {
            promptCalls.push({ message, options });
            return {
              status: 'finished',
              result: '```markdown\n# Fix Cursor Session Titles.\nExtra detail\n```',
            };
          },
        },
      }),
    });

    const title = await runtime.generateTitle({
      text: 'When I use models from the Cursor provider, summarize the session name.',
      directory: '/tmp/project',
    });

    expect(title).toBe('Fix Cursor Session Titles');
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.message).toContain('3 to 7 words');
    expect(promptCalls[0]?.message).toContain('durable subject, problem, or desired outcome');
    expect(promptCalls[0]?.message).toContain('Make a plan to fix unified tablist persistence');
    expect(promptCalls[0]?.message).toContain('<untrusted-session-request-json>');
    expect(promptCalls[0]?.message).toContain('When I use models from the Cursor provider');
    expect(promptCalls[0]?.options).toMatchObject({
      apiKey: 'cursor-sdk-key',
      model: { id: 'auto' },
      local: {
        cwd: '/tmp/project',
        settingSources: [],
      },
      platform: { workspaceRef: '/tmp/project' },
    });
    expect(promptCalls[0]?.options?.agents).toBeUndefined();
  });

  test('removes incidental planning framing without a second Cursor request', async () => {
    let promptCount = 0;
    const runtime = createCursorSdkRuntime({
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      loadSdk: async () => ({
        Agent: {
          prompt: async () => {
            promptCount += 1;
            return { status: 'finished', result: 'Plan unified tablist persistence' };
          },
        },
      }),
    });

    expect(await runtime.generateTitle({
      text: 'Make a plan to fix unified tablist persistence',
    })).toBe('Unified tablist persistence');
    expect(promptCount).toBe(1);
  });

  test('preserves Plan when it is part of the literal session subject', async () => {
    const runtime = createCursorSdkRuntime({
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      loadSdk: async () => ({
        Agent: {
          prompt: async () => ({ status: 'finished', result: 'Plan mode title bias' }),
        },
      }),
    });

    expect(await runtime.generateTitle({ text: 'Fix Plan mode title bias' })).toBe('Plan mode title bias');
  });

  test('returns null for missing input or an empty model response', async () => {
    let promptCount = 0;
    const runtime = createCursorSdkRuntime({
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      loadSdk: async () => ({
        Agent: {
          prompt: async () => {
            promptCount += 1;
            return { status: 'finished', result: '   ' };
          },
        },
      }),
    });

    expect(await runtime.generateTitle({ text: '   ' })).toBeNull();
    expect(await runtime.generateTitle({ text: 'Valid prompt' })).toBeNull();
    expect(promptCount).toBe(1);
  });

  test('caps normalized titles at 80 characters', async () => {
    const runtime = createCursorSdkRuntime({
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      loadSdk: async () => ({
        Agent: {
          prompt: async () => ({
            status: 'finished',
            result: `\"${'A'.repeat(100)}\"`,
          }),
        },
      }),
    });

    const title = await runtime.generateTitle({ text: 'Long title request' });

    expect(title).toHaveLength(80);
    expect(title).toBe(`${'A'.repeat(77)}...`);
  });
});
