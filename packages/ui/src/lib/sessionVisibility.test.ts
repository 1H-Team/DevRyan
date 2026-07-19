import { describe, expect, test } from 'bun:test';

import {
  filterUserVisibleSessions,
  isUserVisibleSessionRecord,
  SMARTFETCH_SECONDARY_SESSION_TITLE,
} from './sessionVisibility';
import {
  registerGitGenerationSession,
  unregisterGitGenerationSession,
} from './git/gitGenerationSessions';

describe('session visibility policy', () => {
  test('hides SmartFetch secondary-model helper sessions', () => {
    expect(isUserVisibleSessionRecord({
      id: 'ses_smartfetch',
      title: SMARTFETCH_SECONDARY_SESSION_TITLE,
    })).toBe(false);
    expect(isUserVisibleSessionRecord({
      id: 'ses_smartfetch_spaced',
      title: `  ${SMARTFETCH_SECONDARY_SESSION_TITLE}  `,
    })).toBe(false);
  });

  test('keeps similarly named user sessions visible', () => {
    expect(isUserVisibleSessionRecord({
      id: 'ses_user',
      title: 'Investigate smartfetch-secondary sessions',
    })).toBe(true);
    expect(isUserVisibleSessionRecord({
      id: 'ses_user_suffix',
      title: 'smartfetch-secondary follow-up',
    })).toBe(true);
  });

  test('continues hiding registered Git-generation sessions', () => {
    const sessionId = 'ses_git_generation';
    registerGitGenerationSession(sessionId);
    try {
      expect(isUserVisibleSessionRecord({
        id: sessionId,
        title: 'Generated commit plan',
      })).toBe(false);
    } finally {
      unregisterGitGenerationSession(sessionId);
    }
  });

  test('keeps ordinary root, child, and archived records visible', () => {
    expect(isUserVisibleSessionRecord({ id: 'ses_root', title: 'Root session' })).toBe(true);
    expect(isUserVisibleSessionRecord({ id: 'ses_child', title: 'Child session' })).toBe(true);
    expect(isUserVisibleSessionRecord({ id: 'ses_archived', title: 'Archived session' })).toBe(true);
  });

  test('filters hidden helpers and preserves the source array when unchanged', () => {
    const visible = [
      { id: 'ses_root', title: 'Root session' },
      { id: 'ses_child', title: 'Child session' },
    ];
    expect(filterUserVisibleSessions(visible)).toBe(visible);

    const withHelper = [
      visible[0],
      { id: 'ses_helper', title: SMARTFETCH_SECONDARY_SESSION_TITLE },
      visible[1],
    ];
    const filtered = filterUserVisibleSessions(withHelper);
    expect(filtered).toEqual(visible);
    expect(filtered[0]).toBe(visible[0]);
    expect(filtered[1]).toBe(visible[1]);
  });
});
