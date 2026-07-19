import { describe, expect, test } from 'bun:test';

import {
  buildSessionPlanFilePath,
  ensureSessionPlanFile,
  sanitizePlanPathSegment,
} from './sessionPlanFile';

const identity = {
  projectPath: '/Users/example/Repositories/Test',
  sessionCreated: 1_721_234_567_890,
  sessionSlug: 'Add clamp / helper',
  sourceMessageId: 'msg_01/../latest',
};

describe('session plan files', () => {
  test('constructs a deterministic revision-specific canonical path with sanitized segments', () => {
    expect(sanitizePlanPathSegment(' Add clamp / helper ')).toBe('Add-clamp-helper');
    expect(buildSessionPlanFilePath('/Users/example', identity)).toBe(
      '/Users/example/.config/openchamber/projects/path_L1VzZXJzL2V4YW1wbGUvUmVwb3NpdG9yaWVzL1Rlc3Q/plans/1721234567890-Add-clamp-helper-msg_01-latest.md',
    );

    expect(buildSessionPlanFilePath('/Users/example', {
      ...identity,
      sourceMessageId: 'msg_02',
    })).not.toBe(buildSessionPlanFilePath('/Users/example', identity));
  });

  test('writes the exact Markdown once and hydrates an existing revision without overwriting edits', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    let exists = false;
    const markdown = '# Clamp plan\n\n- Add the helper\n';
    const storage = {
      resolveHomeDirectory: async () => '/Users/example',
      statFile: async () => ({ exists, isFile: exists }),
      createDirectory: async () => undefined,
      writeFile: async (path: string, content: string) => {
        exists = true;
        writes.push({ path, content });
      },
    };

    const created = await ensureSessionPlanFile({ identity, markdown, storage });
    expect(created.created).toBe(true);
    expect(writes).toEqual([{ path: created.path, content: markdown }]);

    const hydrated = await ensureSessionPlanFile({
      identity,
      markdown: '# This chat rendering must not replace editor changes',
      storage,
    });
    expect(hydrated).toEqual({ path: created.path, created: false });
    expect(writes).toHaveLength(1);
  });

  test('surfaces write failures so the caller can expose retry', async () => {
    let attempts = 0;
    const storage = {
      resolveHomeDirectory: async () => '/Users/example',
      statFile: async () => ({ exists: false, isFile: false }),
      createDirectory: async () => undefined,
      writeFile: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      },
    };

    let firstError: unknown = null;
    try {
      await ensureSessionPlanFile({ identity, markdown: '# Plan', storage });
    } catch (error) {
      firstError = error;
    }
    expect(firstError instanceof Error ? firstError.message : '').toBe('disk full');
    const retried = await ensureSessionPlanFile({ identity, markdown: '# Plan', storage });
    expect(retried.created).toBe(true);
    expect(attempts).toBe(2);
  });
});
