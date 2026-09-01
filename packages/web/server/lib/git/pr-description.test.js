import { describe, expect, it, vi } from 'vitest';

import { generatePullRequestDescriptionDirect, PR_GENERATION_MODEL_TIMEOUT_MS } from './pr-description.js';

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
    })).rejects.toMatchObject({ code: 'FREE_ZEN_EXHAUSTED', attempts: 2 });
  });
});
