import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { collectSidebarChildHydrationTargets } from './sidebarChildHydration';
import type { SessionNode } from './types';

const session = (id: string, directory: string, parentID?: string): Session => ({
  id,
  directory,
  ...(parentID ? { parentID } : {}),
  title: id,
  time: { created: 1, updated: 2 },
} as Session);

const node = (value: Session, children: SessionNode[] = []): SessionNode => ({
  session: value,
  children,
  worktree: null,
});

describe('sidebar child hydration targets', () => {
  test('keeps automatic child discovery inside the active directory', () => {
    const active = session('ses_active', '/repo/active/');
    const inactive = session('ses_inactive', '/repo/inactive');

    const targets = collectSidebarChildHydrationTargets({
      sections: [
        {
          projectId: 'active-project',
          groups: [{ directory: '/repo/active', sessions: [node(active)] }],
        },
        {
          projectId: 'inactive-project',
          groups: [{ directory: '/repo/inactive', sessions: [node(inactive)] }],
        },
      ],
      collapsedProjectIds: new Set(),
      currentSessionId: 'ses_inactive',
      sessions: [active, inactive],
      activeDirectory: '/REPO/ACTIVE',
      limit: 40,
    });

    expect(targets).toEqual([{
      sessionId: 'ses_active',
      directory: '/repo/active',
      refreshKey: '1:2:0',
    }]);
  });
});
