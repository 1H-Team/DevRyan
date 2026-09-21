/**
 * Pure helpers for splitting a unified diff into per-hunk patches.
 *
 * Used by the per-hunk stage/unstage/discard flow: a whole-file unified diff
 * (as produced by `git diff`) is split into standalone single-hunk patches,
 * each of which can be fed to `git apply` on its own.
 *
 * These helpers are intentionally dependency-free and DOM-free so they unit test
 * in isolation.
 */

/**
 * Split a unified diff patch for a single file into standalone per-hunk patches.
 *
 * Each returned patch preserves the original file header (everything before the
 * first `@@` hunk header) plus exactly one hunk, producing a patch that can be
 * fed to `git apply` on its own.
 *
 * Returns an empty array when no hunk headers are present.
 */
export const splitPatchIntoHunks = (patch: string): string[] => {
  if (!patch) return [];

  const lines = patch.split('\n');
  const hunkHeaderRegex = /^@@\s/;
  const headerLines: string[] = [];
  let firstHunk = 0;
  while (firstHunk < lines.length && !hunkHeaderRegex.test(lines[firstHunk] ?? '')) {
    headerLines.push(lines[firstHunk]);
    firstHunk += 1;
  }

  if (firstHunk >= lines.length) {
    return [];
  }

  const hunks: string[][] = [];
  for (let index = firstHunk; index < lines.length; index += 1) {
    const line = lines[index];
    if (hunkHeaderRegex.test(line ?? '')) {
      hunks.push([...headerLines, line]);
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1].push(line ?? '');
    }
  }

  return hunks.map((hunkLines) => hunkLines.join('\n'))
    .filter((hunk) => hunk.trim().length > 0)
    .map((hunk) => (hunk.endsWith('\n') ? hunk : `${hunk}\n`));
};

/**
 * Extract a standalone patch for a single hunk by zero-based index.
 *
 * Returns `null` when the index is out of range or the patch has no hunks.
 */
export const extractHunkPatch = (patch: string, hunkIndex: number): string | null => {
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) return null;
  const hunks = splitPatchIntoHunks(patch);
  return hunks[hunkIndex] ?? null;
};
