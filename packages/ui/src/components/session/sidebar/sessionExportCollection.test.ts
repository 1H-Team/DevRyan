import { describe, expect, test } from 'bun:test';
import type { Message, Session } from '@opencode-ai/sdk/v2';
import { collectChildSessionExports, loadSessionExportRecords, SessionExportLoadError, type SessionExportSource } from './sessionExportCollection';
import type { SessionNode } from './types';

const node = (id: string, children: SessionNode[] = []): SessionNode => ({
  session: { id, title: id, time: { created: 1, updated: 1 } } as Session,
  children,
  worktree: null,
});

const record = (sessionID: string) => ({ info: { id: `msg_${sessionID}`, sessionID } as Message, parts: [] });

function source(failing: Set<string> = new Set()) {
  const loads: Array<{ directory: string; sessionID: string }> = [];
  const value: SessionExportSource & { describe: (session: Session) => { title: string } } = {
    directory: '/repo/background',
    ensureRenderable: async (target) => {
      loads.push(target);
      return !failing.has(target.sessionID);
    },
    readRecords: (sessionID) => [record(sessionID)],
    describe: (session) => ({ title: session.title ?? session.id }),
  };
  return { value, loads };
}

describe('session export collection', () => {
  test('loads the root and every child from the row directory, not the active one', async () => {
    const { value, loads } = source();
    const records = await loadSessionExportRecords(value, 'root');
    const collected = await collectChildSessionExports(value, [node('child', [node('grandchild')])]);

    expect(records).toEqual([record('root')]);
    expect(loads).toEqual(['root', 'child', 'grandchild'].map((sessionID) => ({ directory: '/repo/background', sessionID })));
    expect(collected.skipped).toBe(0);
    expect(collected.children[0]?.children[0]?.records).toEqual([record('grandchild')]);
  });

  test('a root that cannot be made renderable fails instead of exporting cached partial history', async () => {
    const { value } = source(new Set(['root']));
    await expect(loadSessionExportRecords(value, 'root')).rejects.toBeInstanceOf(SessionExportLoadError);
  });

  test('a failed child counts itself and its descendants as skipped and the rest still export', async () => {
    const { value, loads } = source(new Set(['broken']));
    const collected = await collectChildSessionExports(value, [
      node('broken', [node('broken-child', [node('broken-grandchild')])]),
      node('healthy'),
    ]);

    expect(collected.skipped).toBe(3);
    expect(collected.children.map((child) => child.title)).toEqual(['healthy']);
    expect(loads.map((load) => load.sessionID)).toEqual(['broken', 'healthy']);
  });
});
