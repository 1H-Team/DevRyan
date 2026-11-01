import { describe, expect, it } from 'vitest';

import { BRANCH_NAME_PROMPT_MAX_LENGTH, buildBranchNamePrompt, normalizeBranchSlug } from './branch-name.js';

describe('normalizeBranchSlug', () => {
  it('keeps a well-formed slug', () => {
    expect(normalizeBranchSlug('homepage-language-audit')).toBe('homepage-language-audit');
  });

  it('turns prose, quotes and punctuation into kebab case', () => {
    expect(normalizeBranchSlug('"Homepage Language Audit."')).toBe('homepage-language-audit');
    expect(normalizeBranchSlug('Fix: login_timeout!!')).toBe('fix-login-timeout');
  });

  it('reads the first line inside a code fence', () => {
    expect(normalizeBranchSlug('```\nfix-login-timeout\n```')).toBe('fix-login-timeout');
    expect(normalizeBranchSlug('\n\nadd-dark-mode\nbecause the user asked')).toBe('add-dark-mode');
  });

  it('drops a repeated prefix or label', () => {
    expect(normalizeBranchSlug('DevRyan/homepage-audit')).toBe('homepage-audit');
    expect(normalizeBranchSlug('Branch name: homepage-audit')).toBe('homepage-audit');
  });

  it('folds accents and drops other unicode', () => {
    expect(normalizeBranchSlug('Café menü 🚀 update')).toBe('cafe-menu-update');
  });

  it('caps words and length', () => {
    expect(normalizeBranchSlug('one two three four five six seven')).toBe('one-two-three-four-five');
    const slug = normalizeBranchSlug('internationalization localization accessibility performance');
    expect(slug).toBe('internationalization-localization');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('rejects empty, non-string and unusable output', () => {
    expect(normalizeBranchSlug('')).toBeNull();
    expect(normalizeBranchSlug('   \n ')).toBeNull();
    expect(normalizeBranchSlug('..//~^:?*[')).toBeNull();
    expect(normalizeBranchSlug('x'.repeat(41))).toBeNull();
    expect(normalizeBranchSlug(null)).toBeNull();
  });

  it('only ever yields ref-safe characters', () => {
    for (const value of ['a..b', 'a.lock', '@{x}', '-lead', 'trail-', 'a b\\c']) {
      const slug = normalizeBranchSlug(value);
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe('buildBranchNamePrompt', () => {
  it('fences and caps the request', () => {
    const prompt = buildBranchNamePrompt('y'.repeat(BRANCH_NAME_PROMPT_MAX_LENGTH + 50));
    expect(prompt).toContain('<request>');
    expect(prompt.match(/y/g)).toHaveLength(BRANCH_NAME_PROMPT_MAX_LENGTH);
  });
});
