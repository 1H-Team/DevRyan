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
      zenModel: 'gpt-5-nano',
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

  it('defaults direct generation to the commit-specific Zen model', async () => {
    const requestText = vi.fn(async () => 'fix(git): generate worktree commit message');

    await generateCommitMessageDirect({ context, requestText });

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
      zenModel: 'big-pickle',
      requestText,
    });

    expect(requestText).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: 'big-pickle',
      chatReasoningEffort: 'none',
    }));
  });

  it('does not retry provider failures inside the speed budget and returns a local draft', async () => {
    const requestText = vi.fn().mockRejectedValue(new Error('model unavailable'));
    const onTiming = vi.fn();

    const result = await generateCommitMessageDirect({
      context,
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      fallbackZenModel: 'big-pickle',
      requestText,
      onTiming,
    });

    expect(result._generation.source).toBe('local_fallback');
    expect(result.subject).toMatch(/^chore\(ui\): /);
    expect(requestText).toHaveBeenCalledOnce();
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ retried: false, providerOutcome: 'error' }));
  });

  it('skips the provider when every candidate is cooling down', async () => {
    const requestText = vi.fn();
    const result = await generateCommitMessageDirect({ context, requestText, skipProvider: true });
    expect(result._generation.source).toBe('local_fallback');
    expect(requestText).not.toHaveBeenCalled();
  });
});
