/** Helper-model slug for a new-chat worktree branch (`DevRyan/<slug>`). */

export const BRANCH_NAME_PROMPT_MAX_LENGTH = 4_000;
export const BRANCH_NAME_TIMEOUT_MS = 6_000;
export const BRANCH_NAME_MAX_OUTPUT_TOKENS = 64;
export const BRANCH_SLUG_MAX_WORDS = 5;
export const BRANCH_SLUG_MAX_LENGTH = 40;

/**
 * Reduce model output to a lowercase kebab-case slug that is a valid single
 * ref component, or null when nothing usable remains.
 */
export function normalizeBranchSlug(value) {
  if (typeof value !== 'string') return null;
  const firstLine = value
    .replace(/```[a-z]*\n?/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const words = firstLine
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // A model that repeats the prefix should not produce DevRyan/devryan-*.
    .replace(/^(?:branch\s*(?:name)?\s*:\s*)?(?:devryan\/)?/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, BRANCH_SLUG_MAX_WORDS);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > BRANCH_SLUG_MAX_LENGTH) break;
    slug = next;
  }
  // Only [a-z0-9-] survives, so the remaining check-ref-format hazards are
  // leading/trailing dashes, which the split already removes.
  return slug || null;
}

export function buildBranchNamePrompt(prompt) {
  return `Name the git branch for this task request.\n\n<request>\n${prompt.slice(0, BRANCH_NAME_PROMPT_MAX_LENGTH)}\n</request>`;
}
