import { describe, expect, it, mock } from 'bun:test';

import { createFreeZenCooldowns } from './free-zen-cooldowns.js';
import {
  buildPullRequestDiffContext,
  normalizePullRequestDraft,
  runFreeZenModelRotation,
  shortenPullRequestTitle,
} from './free-zen-generation.js';

describe('free Zen model rotation', () => {
  it('gives every model its own timeout and accepts the final valid result', async () => {
    const request = mock(async ({ model, timeoutMs }) => {
      expect(timeoutMs).toBe(4_500);
      return model === 'free-c' ? 'Useful title' : '';
    });

    const result = await runFreeZenModelRotation({
      models: [{ id: 'free-a' }, { id: 'free-b' }, { id: 'free-c' }],
      timeoutMs: 4_500,
      request,
      accept: (value) => value || null,
    });

    expect(result).toMatchObject({ ok: true, value: 'Useful title', model: 'free-c', attempts: 3, skipped: [] });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('returns sanitized failures after exhausting the complete catalog', async () => {
    const result = await runFreeZenModelRotation({
      models: ['free-a', 'free-b'],
      timeoutMs: 15_000,
      request: mock(async () => {
        const error = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.failures.map((failure) => failure.reason)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('skips cooling models and marks a 429 in the shared cooldowns', async () => {
    const cooldowns = createFreeZenCooldowns({ now: () => 10_000 });
    cooldowns.mark('free-a', 'rate_limited');
    const request = mock(async ({ model }) => {
      if (model === 'free-b') {
        const error = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      }
      return 'ok';
    });

    const result = await runFreeZenModelRotation({
      models: ['free-a', 'free-b', 'free-c'],
      timeoutMs: 1_000,
      request,
      cooldowns,
    });

    expect(request.mock.calls.map(([input]) => input.model)).toEqual(['free-b', 'free-c']);
    expect(result).toMatchObject({ ok: true, model: 'free-c', skipped: [{ model: 'free-a', reason: 'cooling_down' }] });
    expect(cooldowns.isCoolingDown('free-b')).toBe(true);
    expect(cooldowns.isCoolingDown('free-c')).toBe(false);
  });

  it('marks transient failures and invalid output with the short cooldown', async () => {
    const cooldowns = createFreeZenCooldowns({ now: () => 10_000, longMs: 1_000, shortMs: 100 });
    await runFreeZenModelRotation({
      models: ['timeout-model', 'invalid-model'],
      timeoutMs: 1_000,
      request: mock(async ({ model }) => {
        if (model === 'timeout-model') throw new Error('Zen generation timed out');
        return 'garbage';
      }),
      accept: () => null,
      cooldowns,
    });
    expect(cooldowns.snapshot()).toEqual([
      { model: 'timeout-model', reason: 'timeout', until: 10_100 },
      { model: 'invalid-model', reason: 'invalid_output', until: 10_100 },
    ]);
  });

  it('tries every model anyway when all of them are cooling down', async () => {
    const cooldowns = createFreeZenCooldowns({ now: () => 10_000 });
    cooldowns.mark('free-a', 'rate_limited');
    cooldowns.mark('free-b', 'rate_limited');
    const request = mock(async ({ model }) => (model === 'free-b' ? 'recovered' : ''));

    const result = await runFreeZenModelRotation({
      models: ['free-a', 'free-b'],
      timeoutMs: 1_000,
      request,
      accept: (value) => value || null,
      cooldowns,
    });

    expect(request.mock.calls.map(([input]) => input.model)).toEqual(['free-a', 'free-b']);
    expect(result).toMatchObject({ ok: true, model: 'free-b', skipped: [] });
  });

  it('bounds the rotation to the first N warm models', async () => {
    const request = mock(async () => '');
    const result = await runFreeZenModelRotation({
      models: ['a', 'b', 'c', 'd', 'e'],
      timeoutMs: 1_000,
      request,
      accept: (value) => value || null,
      maxModels: 3,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.skipped).toEqual([{ model: 'd', reason: 'max_models' }, { model: 'e', reason: 'max_models' }]);
    expect(result.attempts).toBe(3);
  });

  it('stops when the total deadline is exhausted and clamps the per-model timeout', async () => {
    let clock = 0;
    const seenTimeouts = [];
    const result = await runFreeZenModelRotation({
      models: ['a', 'b', 'c'],
      timeoutMs: 15_000,
      deadlineMs: 20_000,
      now: () => clock,
      request: async ({ timeoutMs }) => {
        seenTimeouts.push(timeoutMs);
        clock += 12_000;
        throw new Error('upstream exploded');
      },
    });
    expect(seenTimeouts).toEqual([15_000, 8_000]);
    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      deadlineExceeded: true,
      skipped: [{ model: 'c', reason: 'deadline' }],
    });
  });
});

describe('PR draft normalization', () => {
  it('extracts a valid JSON object from fenced output', () => {
    expect(normalizePullRequestDraft('```json\n{"title":"Improve title generation","body":"## Summary\\n- Rotate free models"}\n```'))
      .toEqual({ title: 'Improve title generation', body: '## Summary\n- Rotate free models' });
  });

  it('rejects incomplete output', () => {
    expect(normalizePullRequestDraft('{"title":"Missing body"}')).toBeNull();
    expect(normalizePullRequestDraft('{"title":"","body":"has body"}')).toBeNull();
    expect(normalizePullRequestDraft('')).toBeNull();
    expect(normalizePullRequestDraft('Only a title line')).toBeNull();
  });

  it('strips labels, quotes and headings from the title', () => {
    expect(shortenPullRequestTitle('Title: "Fix the thing"')).toBe('Fix the thing');
    expect(shortenPullRequestTitle('## `Fix the thing`')).toBe('Fix the thing');
    expect(shortenPullRequestTitle('  PR title -  “Fix   the thing” ')).toBe('Fix the thing');
    expect(normalizePullRequestDraft({ title: "'Add cooldowns'", body: 'x' })).toEqual({ title: 'Add cooldowns', body: 'x' });
  });

  it('shortens long titles at a word boundary instead of rejecting the draft', () => {
    const longTitle = 'Rotate through every free model with a shared cooldown before falling back to the configured Builder model';
    const shortened = shortenPullRequestTitle(longTitle);
    expect(shortened.length).toBeLessThanOrEqual(80);
    expect(shortened.endsWith('…')).toBe(true);
    expect(shortened).toBe('Rotate through every free model with a shared cooldown before falling back to…');
    expect(normalizePullRequestDraft({ title: longTitle, body: '## Summary\n- ok' })?.title).toBe(shortened);

    const giantToken = 'x'.repeat(120);
    expect(shortenPullRequestTitle(giantToken)).toBe(`${'x'.repeat(79)}…`);

    const exact = 'a'.repeat(80);
    expect(shortenPullRequestTitle(exact)).toBe(exact);
  });

  it('accepts plain-text drafts and body aliases', () => {
    expect(normalizePullRequestDraft('Title: Add cooldowns\n\n## Summary\n- share cooldowns across features'))
      .toEqual({ title: 'Add cooldowns', body: '## Summary\n- share cooldowns across features' });
    expect(normalizePullRequestDraft({ title: 'Alias', description: '```markdown\n## Summary\n- body\n```' }))
      .toEqual({ title: 'Alias', body: '## Summary\n- body' });
  });
});

describe('PR diff context', () => {
  const fileDiff = (path, lines) => [
    `diff --git a/${path} b/${path}`,
    'index 000..111 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...Array.from({ length: lines }, (_, index) => `+line ${index} of ${path} ${'x'.repeat(40)}`),
  ].join('\n');

  it('returns nothing for an empty diff', () => {
    expect(buildPullRequestDiffContext({ diff: '', stat: '' })).toMatchObject({ text: '', truncated: false, fileCount: 0 });
  });

  it('keeps small diffs intact and skips binary files', () => {
    const diff = [
      fileDiff('src/a.ts', 3),
      'diff --git a/logo.png b/logo.png\nindex 000..111\nBinary files a/logo.png and b/logo.png differ',
      fileDiff('src/b.ts', 2),
    ].join('\n');
    const context = buildPullRequestDiffContext({ diff, stat: ' src/a.ts | 3 +\n 2 files changed' });
    expect(context.truncated).toBe(false);
    expect(context.fileCount).toBe(2);
    expect(context.skippedBinary).toEqual(['logo.png']);
    expect(context.text).toContain('Diff stat:\nsrc/a.ts | 3 +');
    expect(context.text).toContain('binary files skipped: logo.png');
    expect(context.text).toContain('+line 2 of src/a.ts');
    expect(context.text).not.toContain('Binary files');
  });

  it('truncates the largest files first under the cap', () => {
    const diff = [fileDiff('small.ts', 4), fileDiff('huge.ts', 400), fileDiff('medium.ts', 40)].join('\n');
    const context = buildPullRequestDiffContext({ diff, maxChars: 8_000 });
    expect(context.truncated).toBe(true);
    expect(context.includedChars).toBeLessThanOrEqual(8_000);
    expect(context.text.length).toBeLessThanOrEqual(8_000 + 200);
    expect(context.text).toMatch(/^Diff \(truncated to \d+ of \d+ chars\)/);
    expect(context.text).toContain('+line 3 of small.ts');
    expect(context.text).toContain('+line 39 of medium.ts');
    expect(context.text).toContain('[truncated');
    expect(context.text).not.toContain('+line 399 of huge.ts');
    expect(context.omitted).toEqual([]);
  });
});
