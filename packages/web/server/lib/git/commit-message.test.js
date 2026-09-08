import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFreeZenCooldowns } from '@openchamber/shared-runtime';

import {
  COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
  COMMIT_GENERATION_CHAT_MAX_TOKENS,
  COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
  buildCommitMessagePrompt,
  COMMIT_GENERATION_TIMEOUT_MS,
  generateCommitMessageDirect,
  normalizeGeneratedCommitSubject,
} from './commit-message.js';

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
  afterEach(() => vi.useRealTimers());
  it('builds a staged-worktree prompt with non-authoritative guidance', () => {
    const prompt = buildCommitMessagePrompt(context, 'Prefer a ui scope');

    expect(prompt).toContain('respect staged-only scope');
    expect(prompt).toContain('"stagedOnly":true');
    expect(prompt).toContain('Git context');
    expect(prompt).toContain('Prefer a ui scope');
    expect(prompt).toContain('remain authoritative');
  });

  it('normalizes plain, fenced, and legacy JSON subjects', () => {
    expect(normalizeGeneratedCommitSubject('fix(ui): generate commit subject')).toBe('fix(ui): generate commit subject');
    expect(normalizeGeneratedCommitSubject('```text\nchore: update fixtures\n```')).toBe('chore: update fixtures');
    expect(normalizeGeneratedCommitSubject('[{"subject":"docs: explain source generation"}]')).toBe('docs: explain source generation');
  });

  it('rejects malformed subjects and repairs punctuation and oversized summaries', () => {
    expect(() => normalizeGeneratedCommitSubject('Update commit generation')).toThrow(/conventional commit/);
    expect(normalizeGeneratedCommitSubject('fix: update commit generation.')).toBe('fix: update commit generation');
    expect(normalizeGeneratedCommitSubject(`fix: ${'fast generation '.repeat(8)}`).length).toBeLessThanOrEqual(72);
  });

  it('calls only the injected direct text transport and returns one subject', async () => {
    const requestText = vi.fn(async () => JSON.stringify({
      subject: 'fix(git): generate worktree commit message',
      details: ['Generate a direct commit draft', 'Avoid OpenCode sessions'],
    }));

    const result = await generateCommitMessageDirect({
      context,
      guidance: '',
      models: ['gpt-5-nano'],
      requestText,
    });

    expect(result).toMatchObject({
      subject: 'fix(git): generate worktree commit message',
      highlights: ['Generate a direct commit draft', 'Avoid OpenCode sessions'],
      _generation: { source: 'ai', providerOutcome: 'complete' },
    });
    expect(requestText).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: 'gpt-5-nano',
      chatMaxTokens: COMMIT_GENERATION_CHAT_MAX_TOKENS,
      chatReasoningEffort: 'none',
      responsesMaxOutputTokens: COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
    }));
    expect(requestText.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(COMMIT_GENERATION_TIMEOUT_MS);
    expect(requestText.mock.calls.flat().join(' ')).not.toMatch(/\/session|prompt_async/);
  });

  it('uses the catalog model selected by the route', async () => {
    const requestText = vi.fn(async () => 'fix(git): generate worktree commit message');

    await generateCommitMessageDirect({ context, models: [COMMIT_GENERATION_DEFAULT_ZEN_MODEL], requestText });

    expect(COMMIT_GENERATION_DEFAULT_ZEN_MODEL).toBe('nemotron-3.5-lightning-free');
    expect(requestText).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      chatReasoningEffort: 'none',
    }));
  });

  it('disables hidden reasoning for explicit model overrides', async () => {
    const requestText = vi.fn(async () => 'fix(git): generate worktree commit message');

    await generateCommitMessageDirect({
      context,
      models: ['big-pickle'],
      requestText,
    });

    expect(requestText).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: 'big-pickle',
      chatReasoningEffort: 'none',
    }));
  });

  it('advances immediately through failures and accepts the third model', async () => {
    vi.useFakeTimers();
    const requestText = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('Rate limit'), { status: 429 }))
      .mockResolvedValueOnce(JSON.stringify({ subject: 'fix(git): recover commit generation', details: ['Try available models', 'Recover immediately'] }));
    const onAttempt = vi.fn();
    const result = await generateCommitMessageDirect({
      context, models: ['a', 'b', 'c'], requestText, onAttempt,
      cooldowns: createFreeZenCooldowns(),
    });
    expect(result).toMatchObject({ subject: 'fix(git): recover commit generation', _generation: { source: 'ai', attempts: 3, model: 'c' } });
    expect(requestText.mock.calls.map(([input]) => input.zenModel)).toEqual(['a', 'b', 'c']);
    expect(onAttempt.mock.calls.map(([attempt]) => attempt.reason)).toEqual(['request_failed', 'rate_limited', undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid output before falling back only after three attempts', async () => {
    const requestText = vi.fn(async () => 'invalid draft');
    const onTiming = vi.fn();
    const result = await generateCommitMessageDirect({
      context, models: ['a', 'b', 'c', 'd'], requestText, onTiming,
      cooldowns: createFreeZenCooldowns(),
    });
    expect(result._generation).toMatchObject({ source: 'local_fallback', attempts: 3, providerOutcome: 'exhausted' });
    expect(result.subject).toMatch(/^chore\(ui\): /);
    expect(requestText).toHaveBeenCalledTimes(3);
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ retried: true, providerOutcome: 'exhausted' }));
  });

  it('waits up to 15 seconds per attempt and allows the third attempt past 20 seconds', async () => {
    vi.useFakeTimers();
    const signals = [];
    const requestText = vi.fn(({ signal }) => {
      signals.push(signal);
      if (signals.length === 3) return Promise.resolve(JSON.stringify({ subject: 'fix: recover after timeouts', details: ['Abort slow requests', 'Try the third model'] }));
      return new Promise(() => {});
    });
    const pending = generateCommitMessageDirect({ context, models: ['a', 'b', 'c'], requestText, cooldowns: createFreeZenCooldowns() });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requestText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(requestText).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending)._generation).toMatchObject({ source: 'ai', model: 'c', attempts: 3 });
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a local draft only after all three 15-second timeouts', async () => {
    vi.useFakeTimers();
    const requestText = vi.fn(() => new Promise(() => {}));
    const pending = generateCommitMessageDirect({ context, models: ['a', 'b', 'c'], requestText, cooldowns: createFreeZenCooldowns() });
    let finished = false;
    void pending.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending)._generation).toMatchObject({ source: 'local_fallback', attempts: 3, failures: [
      expect.objectContaining({ reason: 'timeout' }), expect.objectContaining({ reason: 'timeout' }), expect.objectContaining({ reason: 'timeout' }),
    ] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['empty', 'unavailable'])('discloses a %s catalog without guessing a model', async (catalogState) => {
    const requestText = vi.fn();
    const result = await generateCommitMessageDirect({ context, models: [], requestText, catalogState });
    expect(result._generation).toMatchObject({ source: 'local_fallback', attempts: 0, providerOutcome: catalogState === 'empty' ? 'no_free_models' : 'catalog_unavailable' });
    expect(requestText).not.toHaveBeenCalled();
  });
});
