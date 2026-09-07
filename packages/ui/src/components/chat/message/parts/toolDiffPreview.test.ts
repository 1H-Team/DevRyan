import { describe, expect, test, spyOn } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { extractPatchFileSummariesFromToolPart, getToolPartDiffStatsFromToolPart } from './tool-activity/targets';
import {
  TOOL_DIFF_PREVIEW_MAX_CHARS as MAX_CHARS,
  TOOL_DIFF_PREVIEW_MAX_LINES as MAX_LINES,
  getToolDiffPreview,
  getWriteDiffPreview,
  getPatchText,
  buildWritePreviewPatch,
} from './toolDiffPreview';
import { getDiffPatchEntries, resolveRawPatchFallback, splitUnifiedDiffPatch } from './toolPartDiffEntries';

describe('bounded tool diff previews', () => {
  test('accepts the exact character limit and bounds a single oversized line', () => {
    const exact = 'x'.repeat(MAX_CHARS);
    expect(getToolDiffPreview(exact)).toEqual({ text: exact, truncated: false });
    expect(getToolDiffPreview(`${exact}y`)).toEqual({ text: exact, truncated: true });
  });

  for (const separator of ['\n', '\r\n', '\r']) test(`counts line boundaries with ${JSON.stringify(separator)}`, () => {
    const exact = Array.from({ length: MAX_LINES }, () => 'line').join(separator);
    expect(getToolDiffPreview(exact)).toEqual({ text: exact, truncated: false });
    expect(getToolDiffPreview(exact + separator).truncated).toBe(false);
    expect(getToolDiffPreview(`${exact}${separator}extra`)).toEqual({ text: exact, truncated: true });
  });

  test('does not split an emoji or CRLF at the character boundary', () => {
    const prefix = 'x'.repeat(MAX_CHARS - 1);
    expect(getToolDiffPreview(`${prefix}😀tail`)).toEqual({ text: prefix, truncated: true });
    expect(getToolDiffPreview(`${prefix}\r\ntail`)).toEqual({ text: prefix, truncated: true });
  });

  test('oversized multi-file and malformed patches bypass file splitting and keep exact source', () => {
    const source = `  --- a/one\r\n+++ b/one\r\n@@ -1 +1 @@\r\n-old\r\n+${'x'.repeat(MAX_CHARS)}\r\n--- a/two\r\n+++ b/two\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n`;
    expect(getPatchText(source)).toBe(source);
    expect(splitUnifiedDiffPatch(source)).toEqual([{ id: 'oversized-0', title: 'Diff 1', patch: source }]);
    const entries = getDiffPatchEntries({ files: [{ relativePath: 'combined.patch', patch: source }] }, '', '/repo');
    expect(entries).toHaveLength(1);
    expect(entries[0].patch).toBe(source);
    expect(entries[0].title).toBe('combined.patch');
    const malformed = ' '.repeat(MAX_CHARS + 1);
    expect(resolveRawPatchFallback(malformed, [])).toBe(malformed);
    expect(getDiffPatchEntries(undefined, malformed, '/repo')[0].patch).toBe(malformed);
    expect(getToolDiffPreview(entries[0].patch).text.length).toBeLessThan(MAX_CHARS + 1);
  });

  test('metadata diff aliases keep oversized source intact', () => {
    const source = 'x'.repeat(MAX_CHARS + 1);
    expect(getPatchText({ patch: source })).toBe(source);
    for (const alias of ['patch', 'patchText', 'diff', 'changes']) {
      expect(getDiffPatchEntries({ files: [{ filePath: '/repo/file', [alias]: source }] }, '', '/repo')[0]).toEqual({
        id: 'oversized-0', title: 'file', patch: source,
      });
    }
  });

  test('header summaries and preview entries never split an oversized patch or invent partial counts', () => {
    const source = `--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+${'x'.repeat(MAX_CHARS)}`;
    const part = { id: 'p', sessionID: 's', messageID: 'm', callID: 'c', type: 'tool', tool: 'apply_patch',
      state: { status: 'completed', input: {}, metadata: { patch: source }, output: '', title: 'Patch', time: { start: 1, end: 2 } } } satisfies ToolPart;
    const originalSplit = String.prototype.split;
    let oversizedSplits = 0;
    const split = spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator: string | Parameters<string['split']>[0], limit?: number): string[] {
      if (String(this) === source) oversizedSplits += 1;
      return Reflect.apply(originalSplit, this, [separator, limit]);
    });
    try {
      expect(splitUnifiedDiffPatch(source)).toHaveLength(1);
      expect(extractPatchFileSummariesFromToolPart(part)[0]).toMatchObject({ path: 'Patch', patch: source, additions: undefined });
      expect(getToolPartDiffStatsFromToolPart(part)).toBeNull();
      const metadata = { files: [{ relativePath: 'file', patch: source, additions: 4000, deletions: 3 }] };
      const withCounts: ToolPart = { ...part, state: { ...part.state, metadata } };
      expect(getToolPartDiffStatsFromToolPart(withCounts)).toEqual({ additions: 4000, deletions: 3 });
      expect(getDiffPatchEntries(metadata, '', '/repo')[0].patch).toBe(source);
      expect(oversizedSplits).toBe(0);
    } finally {
      split.mockRestore();
    }
  });

  test('write content is bounded before building the full synthetic patch', () => {
    const content = 'body\r\n'.repeat(MAX_LINES + 100);
    const preview = getWriteDiffPreview('/repo/new.txt', content);
    expect(preview.truncated).toBe(true);
    // The bounded content preview contains neither a full patch body nor its unbounded hunk count.
    expect(preview.patch).toBe(getToolDiffPreview(content).text);
    expect(preview.getFullPatch()).toBe(buildWritePreviewPatch('/repo/new.txt', content));
    expect(preview.getFullPatch()).toContain('+++ b/repo/new.txt');
    expect(preview.getFullPatch().length).toBeGreaterThan(preview.patch.length);
  });

  test('bounds generated patch overhead even when the write input itself fits', () => {
    const preview = getWriteDiffPreview('file', 'x'.repeat(MAX_CHARS));
    expect(preview.truncated).toBe(true);
    expect(preview.patch.length).toBe(MAX_CHARS);
    expect(preview.getFullPatch().length).toBeGreaterThan(MAX_CHARS);
    const normal = getWriteDiffPreview(undefined, 'a\r\nb');
    expect(normal.truncated).toBe(false);
    expect(normal.patch).toBe('--- /dev/null\n+++ b/new-file\n@@ -0,0 +1,2 @@\n+a\n+b');
    expect(normal.getFullPatch()).toBe(normal.patch);
  });
});
