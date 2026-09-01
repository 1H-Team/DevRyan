import { describe, expect, test } from 'bun:test';
import type { Message, Session } from '@opencode-ai/sdk/v2/client';
import { opencodeClient } from '@/lib/opencode/client';

import {
  __testArchivedAssistantHydration,
  isSessionNotFoundHydrationError,
} from './useSidebarArchivedAssistantActivityHydration';
import { __testUserActivityHydration } from './useSidebarUserActivityHydration';
import {
  getSidebarSessionDirectory,
  isActiveSidebarHydrationDirectory,
} from './sidebarHydrationUtils';

const session = (id: string, fields: Partial<Session> = {}): Session => ({
  id,
  time: {
    created: 1,
    updated: 1,
  },
  title: id,
  ...fields,
} as Session);

describe('sidebar hydration helpers', () => {
  test('matches only normalized active-directory hydration targets', () => {
    expect(isActiveSidebarHydrationDirectory('/Users/Example/Repo/', '/users/example/repo')).toBe(true);
    expect(isActiveSidebarHydrationDirectory('C:\\Work\\Repo', 'c:/work/repo/')).toBe(true);
    expect(isActiveSidebarHydrationDirectory('/repo-a', '/repo-b')).toBe(false);
    expect(isActiveSidebarHydrationDirectory('/repo-a', null)).toBe(false);
  });

  test('resolves explicit session directories before project worktrees', () => {
    expect(getSidebarSessionDirectory(session('ses_explicit', {
      directory: '/explicit',
      project: { worktree: '/project' },
    } as Partial<Session>))).toBe('/explicit');
    expect(getSidebarSessionDirectory(session('ses_project', {
      project: { worktree: '/project/' },
    } as Partial<Session>))).toBe('/project');
  });

  test('collects historical user activity only for root sessions in the active directory', () => {
    const candidates = __testUserActivityHydration.collectCandidates({
      sessions: [
        session('ses_active', { directory: '/repo/active/' } as Partial<Session>),
        session('ses_child', { directory: '/repo/active', parentID: 'ses_active' } as Partial<Session>),
        session('ses_inactive', { directory: '/repo/inactive' } as Partial<Session>),
      ],
      activityBySessionId: {},
      activeDirectory: '/REPO/ACTIVE',
      resolvedKeys: new Set(),
      inFlightKeys: new Set(),
    });

    expect(candidates.map((candidate) => candidate.session.id)).toEqual(['ses_active']);
  });

  test('hydrates past hidden prompts until it finds the visible side of a revert marker', async () => {
    const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient;
    const calls: Array<string | undefined> = [];
    const makeMessage = (id: string, role: 'user' | 'assistant', created: number): Message => ({
      id,
      sessionID: 'ses_reverted',
      role,
      time: { created },
    } as Message);

    Object.defineProperty(opencodeClient, 'getScopedSdkClient', {
      configurable: true,
      value: () => ({
        session: {
          messages: async ({ before }: { before?: string }) => {
            calls.push(before);
            const page = before
              ? [
                  makeMessage('msg_visible', 'user', 100),
                  makeMessage('msg_revert', 'user', 200),
                ]
              : [makeMessage('msg_hidden', 'user', 300)];
            return {
              data: page.map((info) => ({ info, parts: [] })),
              response: {
                headers: { get: () => before ? null : 'older-page' },
              },
            };
          },
        },
      }),
    });

    try {
      const reverted = session('ses_reverted', {
        directory: '/repo',
        revert: { messageID: 'msg_revert' },
      } as Partial<Session>);
      const lastVisibleUserMessageAt = await __testUserActivityHydration.fetchLastUserMessageAt(reverted, '/repo');
      expect(lastVisibleUserMessageAt).toBe(100);
      expect(calls).toEqual([undefined, 'older-page']);
    } finally {
      Object.defineProperty(opencodeClient, 'getScopedSdkClient', {
        configurable: true,
        value: originalGetScopedSdkClient,
      });
    }
  });

  test('dedupes archived assistant fetch candidates by directory and parent session', () => {
    const parent = session('ses_parent', { directory: '/repo' } as Partial<Session>);
    const archivedChildA = session('ses_child_a', {
      directory: '/repo',
      parentID: 'ses_parent',
      time: { created: 1, updated: 2, archived: 3 },
    } as Partial<Session>);
    const archivedChildB = session('ses_child_b', {
      directory: '/repo',
      parentID: 'ses_parent',
      time: { created: 1, updated: 4, archived: 5 },
    } as Partial<Session>);

    const candidates = __testArchivedAssistantHydration.collectCandidates({
      activeSessions: [parent],
      archivedSessions: [archivedChildA, archivedChildB],
      activityByParentSessionId: {},
      getCachedMessages: () => undefined,
      activeDirectory: '/repo',
      resolvedKeys: new Set(),
      inFlightKeys: new Set(),
    });

    expect(candidates.fetch).toHaveLength(1);
    expect(candidates.fetch[0]?.parentSessionId).toBe('ses_parent');
    expect(candidates.fetch[0]?.directory).toBe('/repo');
  });

  test('does not fetch archived activity from inactive directories', () => {
    const active = session('ses_active', {
      directory: '/repo/active',
      time: { created: 1, updated: 2, archived: 3 },
    } as Partial<Session>);
    const inactive = session('ses_inactive', {
      directory: '/repo/inactive',
      time: { created: 1, updated: 2, archived: 3 },
    } as Partial<Session>);

    const candidates = __testArchivedAssistantHydration.collectCandidates({
      activeSessions: [],
      archivedSessions: [active, inactive],
      activityByParentSessionId: {},
      getCachedMessages: () => undefined,
      activeDirectory: '/repo/active',
      resolvedKeys: new Set(),
      inFlightKeys: new Set(),
    });

    expect(candidates.fetch.map((candidate) => candidate.parentSessionId)).toEqual(['ses_active']);
  });

  test('recognizes true missing-session errors for negative caching', () => {
    expect(isSessionNotFoundHydrationError(Object.assign(new Error('missing'), { name: 'NotFoundError' }))).toBe(true);
    expect(isSessionNotFoundHydrationError(Object.assign(new Error('missing'), { status: 404 }))).toBe(true);
    expect(isSessionNotFoundHydrationError({
      response: { status: 404 },
    })).toBe(true);
    expect(isSessionNotFoundHydrationError(new Error('Session not found: ses_1'))).toBe(true);
  });

  test('keeps transient errors retryable', () => {
    expect(isSessionNotFoundHydrationError(Object.assign(new Error('warming up'), { status: 503 }))).toBe(false);
    expect(isSessionNotFoundHydrationError(new TypeError('Failed to fetch'))).toBe(false);
  });
});
