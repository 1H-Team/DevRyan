import { describe, expect, test } from 'bun:test';

import { revealSkillPath } from './skillPathReveal';

describe('revealSkillPath', () => {
  test('reveals the exact absolute skill file path', async () => {
    const revealedPaths: string[] = [];
    let failureCount = 0;
    const skillPath = '/Users/test/.config/opencode/skills/example/SKILL.md';

    expect(await revealSkillPath(async (path) => {
      revealedPaths.push(path);
      return { success: true };
    }, skillPath, () => {
      failureCount += 1;
    })).toBe(true);
    expect(revealedPaths).toEqual([skillPath]);
    expect(failureCount).toBe(0);
  });

  test('reports an unsuccessful reveal', async () => {
    let failureCount = 0;

    expect(await revealSkillPath(async () => ({ success: false }), '/tmp/SKILL.md', () => {
      failureCount += 1;
    })).toBe(false);
    expect(failureCount).toBe(1);
  });

  test('reports a thrown reveal error', async () => {
    let failureCount = 0;

    expect(await revealSkillPath(async () => {
      throw new Error('unavailable');
    }, '/tmp/SKILL.md', () => {
      failureCount += 1;
    })).toBe(false);
    expect(failureCount).toBe(1);
  });
});
