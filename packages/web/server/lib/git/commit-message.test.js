import { describe, expect, it, vi } from 'vitest';

import {
  COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
  COMMIT_GENERATION_CHAT_MAX_TOKENS,
  COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
  buildCommitMessagePrompt,
  COMMIT_GENERATION_TIMEOUT_MS,
  generateCommitMessageDirect,
  normalizeGeneratedCommitSubject,
} from './commit-message.js';
import { ZenApiError } from '../text/summarization.js';

const context = {
  branch: 'feature/source-generation',
  tracking: 'origin/feature/source-generation',
  scope: 'staged-only',
  stagedOnly: true,
  recentCommitSubjects: ['fix(ui): preserve commit input'],
  selectedFiles: [{
    path: 'packages/ui/src/components/views/GitView.tsx',
    index: 'M',
    workingDir: ' ',
    diff: '+generateCommitMessage()',
  }],
};

describe('direct commit message generation', () => {
  it('builds a staged-worktree prompt with non-authoritative guidance', () => {
    const prompt = buildCommitMessagePrompt(context, 'Prefer a ui scope');

    expect(prompt).toContain('Respect the staged-only scope');
    expect(prompt).toContain('"stagedOnly": true');
    expect(prompt).toContain('Git context');
    expect(prompt).toContain('Prefer a ui scope');
    expect(prompt).toContain('remain authoritative');
  });

  it('normalizes plain, fenced, and legacy JSON subjects', () => {
    expect(normalizeGeneratedCommitSubject('fix(ui): generate commit subject')).toBe('fix(ui): generate commit subject');
    expect(normalizeGeneratedCommitSubject('```text\nchore: update fixtures\n```')).toBe('chore: update fixtures');
    expect(normalizeGeneratedCommitSubject('[{"subject":"docs: explain source generation"}]')).toBe('docs: explain source generation');
  });

  it('rejects malformed, punctuated, and oversized subjects', () => {
    expect(() => normalizeGeneratedCommitSubject('Update commit generation')).toThrow(/conventional commit/);
    expect(() => normalizeGeneratedCommitSubject('fix: update commit generation.')).toThrow(/period/);
    expect(() => normalizeGeneratedCommitSubject(`fix: ${'x'.repeat(80)}`)).toThrow(/exceeds 72/);
  });

  it('calls only the injected direct text transport and returns one subject', async () => {
    const requestText = vi.fn(async () => 'fix(git): generate worktree commit message');

    const result = await generateCommitMessageDirect({
      context,
      guidance: '',
      zenModel: 'gpt-5-nano',
      requestText,
    });

    expect(result).toEqual({
      subject: 'fix(git): generate worktree commit message',
      highlights: [],
    });
    expect(requestText).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: 'gpt-5-nano',
      timeoutMs: COMMIT_GENERATION_TIMEOUT_MS,
      chatMaxTokens: COMMIT_GENERATION_CHAT_MAX_TOKENS,
      responsesMaxOutputTokens: COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
      stop: ['\n'],
    }));
    expect(requestText.mock.calls.flat().join(' ')).not.toMatch(/\/session|prompt_async/);
  });

  it('defaults direct generation to the commit-specific Zen model', async () => {
    const requestText = vi.fn(async () => 'fix(git): generate worktree commit message');

    await generateCommitMessageDirect({ context, requestText });

    expect(requestText).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      timeoutMs: COMMIT_GENERATION_TIMEOUT_MS,
      chatReasoningEffort: 'none',
    }));
  });

  it('retries only explicit unavailable-model failures with a different cached fallback', async () => {
    const requestText = vi.fn()
      .mockRejectedValueOnce(new ZenApiError(404, 'model deepseek-v4-flash-free not found'))
      .mockResolvedValueOnce('fix(git): use cached free model');
    const onTiming = vi.fn();

    const result = await generateCommitMessageDirect({
      context,
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      fallbackZenModel: 'big-pickle',
      requestText,
      onTiming,
    });

    expect(result.subject).toBe('fix(git): use cached free model');
    expect(requestText).toHaveBeenCalledTimes(2);
    expect(requestText.mock.calls.map(([request]) => request.zenModel)).toEqual([
      COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      'big-pickle',
    ]);
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ retried: true }));
  });

  it.each([
    new ZenApiError(429, 'rate limit exceeded'),
    new ZenApiError(401, 'authentication failed'),
    new ZenApiError(500, 'server error'),
    new Error('Zen generation timed out'),
  ])('does not retry non-availability failures: %s', async (error) => {
    const requestText = vi.fn().mockRejectedValue(error);

    await expect(generateCommitMessageDirect({
      context,
      fallbackZenModel: 'big-pickle',
      requestText,
    })).rejects.toBe(error);
    expect(requestText).toHaveBeenCalledOnce();
  });
});
