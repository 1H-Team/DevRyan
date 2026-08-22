import { describe, expect, it } from 'bun:test';
import {
  COMMIT_DRAFT_SUBJECT_MAX_LENGTH,
  buildCommitDraftPrompt,
  createDeterministicCommitDraft,
  generateCommitDraftWithDeadline,
  normalizeGeneratedCommitDraft,
} from './commit-message-draft.js';

const context = {
  branch: 'feature/fast-commits',
  stagedOnly: false,
  selectedFiles: [
    { path: 'packages/ui/src/GitView.tsx', index: 'M', workingDir: ' ', insertions: 12, deletions: 3 },
    { path: 'packages/ui/src/GitView.test.tsx', index: 'M', workingDir: ' ', insertions: 8, deletions: 1 },
  ],
  recentCommitSubjects: ['fix(ui): preserve commit input'],
};

describe('shared commit draft generation', () => {
  it('requests compact subject-and-details JSON', () => {
    const prompt = buildCommitDraftPrompt(context, 'Prefer a UI scope');
    expect(prompt).toContain('{"subject"');
    expect(prompt).toContain('2 to 4 concise');
    expect(prompt).toContain('Prefer a UI scope');
  });

  it('normalizes valid JSON and supplies missing factual details', () => {
    const result = normalizeGeneratedCommitDraft(JSON.stringify({
      subject: 'perf(ui): speed commit draft generation',
      details: ['Batch Git context reads'],
    }), context);
    expect(result.source).toBe('repaired_ai');
    expect(result.message.subject).toBe('perf(ui): speed commit draft generation');
    expect(result.message.highlights.length).toBeGreaterThanOrEqual(2);
  });

  it('repairs an oversized conventional subject at a word boundary', () => {
    const result = normalizeGeneratedCommitDraft(JSON.stringify({
      subject: `fix(ui): ${'improve commit generation reliability and performance '.repeat(3)}`,
      details: ['Bound provider time', 'Use a local fallback'],
    }), context);
    expect(result.source).toBe('repaired_ai');
    expect(result.message.subject.length).toBeLessThanOrEqual(COMMIT_DRAFT_SUBJECT_MAX_LENGTH);
    expect(result.message.subject).toMatch(/^fix\(ui\): /);
  });

  it('creates a valid factual local fallback for malformed output', () => {
    const result = normalizeGeneratedCommitDraft('not a conventional subject', context);
    expect(result.source).toBe('local_fallback');
    expect(result.message.subject).toMatch(/^chore\(ui\): /);
    expect(result.message.highlights).toHaveLength(3);
  });

  it('returns a local draft when the provider misses the deadline', async () => {
    let providerCalls = 0;
    const startedAt = Date.now();
    const result = await generateCommitDraftWithDeadline({
      context,
      deadlineAt: startedAt + 40,
      reserveMs: 5,
      requestText: () => {
        providerCalls += 1;
        return new Promise(() => {});
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(providerCalls).toBe(1);
    expect(result.source).toBe('local_fallback');
    expect(result.providerOutcome).toBe('deadline');
  });

  it('builds deterministic details without model output', () => {
    const message = createDeterministicCommitDraft(context);
    expect(message.subject).toBe('chore(ui): update 2 selected files');
    expect(message.highlights).toContain('Change 24 lines (+20/-4)');
  });
});
