import { describe, expect, it, vi } from 'vitest';
import { createFreeZenCooldowns } from '@openchamber/shared-runtime';

import {
  PR_GENERATION_FREE_DEADLINE_MS,
  PR_GENERATION_MAX_FREE_MODELS,
  PR_GENERATION_MODEL_TIMEOUT_MS,
  generatePullRequestDescriptionDirect,
} from './pr-description.js';

describe('direct PR description generation', () => {
  it('tries free models for 15 seconds each until output is valid', async () => {
    const requestText = vi.fn(async ({ zenModel, timeoutMs }) => {
      expect(timeoutMs).toBe(PR_GENERATION_MODEL_TIMEOUT_MS);
      return zenModel === 'free-c'
        ? JSON.stringify({ title: 'Improve PR summaries', body: '## Summary\n- Use free Zen directly' })
        : '{"title":"Incomplete"}';
    });
    const result = await generatePullRequestDescriptionDirect({
      prompt: 'Generate the PR description',
      models: ['free-a', 'free-b', 'free-c'],
      requestText,
      cooldowns: createFreeZenCooldowns(),
    });
    expect(result).toMatchObject({
      title: 'Improve PR summaries',
      body: '## Summary\n- Use free Zen directly',
      _generation: { model: 'free-c', attempts: 3 },
    });
    expect(requestText).toHaveBeenCalledTimes(3);
  });

  it('fails after all free models return invalid output', async () => {
    await expect(generatePullRequestDescriptionDirect({
      prompt: 'Generate the PR description',
      models: ['free-a', 'free-b'],
      requestText: vi.fn(async () => 'not json'),
      cooldowns: createFreeZenCooldowns(),
    })).rejects.toMatchObject({ code: 'FREE_ZEN_EXHAUSTED', attempts: 2 });
  });

  it('shortens an over-long title instead of rejecting the draft', async () => {
    const title = 'Rotate through every free model with a shared cooldown before falling back to the configured Builder model';
    const result = await generatePullRequestDescriptionDirect({
      prompt: 'Generate the PR description',
      models: ['free-a'],
      requestText: vi.fn(async () => JSON.stringify({ title, body: '## Summary\n- ok' })),
      cooldowns: createFreeZenCooldowns(),
    });
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.title.endsWith('…')).toBe(true);
    expect(result.body).toBe('## Summary\n- ok');
  });

  it('is bounded to the first three warm models and marks failures in the shared cooldowns', async () => {
    expect(PR_GENERATION_MAX_FREE_MODELS).toBe(3);
    const cooldowns = createFreeZenCooldowns();
    cooldowns.mark('free-a', 'rate_limited');
    const requestText = vi.fn(async () => {
      const error = new Error('Rate limit exceeded');
      error.status = 429;
      throw error;
    });
    const onAttempt = vi.fn();
    await expect(generatePullRequestDescriptionDirect({
      prompt: 'Generate the PR description',
      models: ['free-a', 'free-b', 'free-c', 'free-d', 'free-e'],
      requestText,
      cooldowns,
      onAttempt,
    })).rejects.toMatchObject({
      code: 'FREE_ZEN_EXHAUSTED',
      attempts: 3,
      skipped: [
        { model: 'free-a', reason: 'cooling_down' },
        { model: 'free-e', reason: 'max_models' },
      ],
    });
    expect(requestText.mock.calls.map(([input]) => input.zenModel)).toEqual(['free-b', 'free-c', 'free-d']);
    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(cooldowns.isCoolingDown('free-d')).toBe(true);
  });

  it('is bounded to 45 seconds in total', async () => {
    expect(PR_GENERATION_FREE_DEADLINE_MS).toBe(45_000);
    let clock = 0;
    const timeouts = [];
    await expect(generatePullRequestDescriptionDirect({
      prompt: 'Generate the PR description',
      models: ['free-a', 'free-b', 'free-c', 'free-d'],
      maxModels: 10,
      now: () => clock,
      cooldowns: createFreeZenCooldowns({ now: () => clock }),
      requestText: vi.fn(async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        clock += 20_000;
        throw new Error('Zen generation timed out');
      }),
    })).rejects.toMatchObject({ code: 'FREE_ZEN_EXHAUSTED', attempts: 3, deadlineExceeded: true });
    expect(timeouts).toEqual([15_000, 15_000, 5_000]);
  });
});
