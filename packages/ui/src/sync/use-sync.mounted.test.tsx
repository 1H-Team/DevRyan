import React, { act, useEffect } from 'react';
import { expect, mock, test } from 'bun:test';
import type { Message, OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { opencodeClient } from '@/lib/opencode/client';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader } from './session-message-loader';
import { SessionHistory } from './session-history';

const directory = '/repo/mounted-consumers';
const sdk = {
  session: {
    get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, directory, title: sessionID, time: { created: 1, updated: 1 } } as Session }),
    messages: async ({ sessionID }: { sessionID: string }) => ({
      data: [{ info: { id: `msg_${sessionID}`, sessionID, role: 'user', time: { created: 1 } } as Message, parts: [] }],
      response: { headers: { get: () => null } },
    }),
  },
} as unknown as OpencodeClient;
Object.defineProperty(opencodeClient, 'getScopedSdkClient', { configurable: true, value: () => sdk });
const stores = new ChildStoreManager();
const loader = new SessionMessageLoader(stores);
const history = new SessionHistory({ childStores: stores, loader, getSdk: () => sdk });

mock.module('./sync-context', () => ({
  useSyncDirectory: () => directory,
  useSessionHistory: () => history,
  useSyncResyncSession: () => async () => undefined,
}));
const { useSync } = await import('./use-sync');

function Consumer({ sessionID }: { sessionID: string }) {
  const sync = useSync();
  useEffect(() => {
    void sync.ensureSessionRenderable(sessionID);
  }, [sessionID, sync]);
  return null;
}

const flush = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

test('100 consumer mount/unmount cycles in either order leave history ownership constant', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const render = async (sessionIDs: string[]) => {
    await act(async () => {
      root.render(<>{sessionIDs.map((sessionID) => <Consumer key={sessionID} sessionID={sessionID} />)}</>);
    });
    await flush();
  };

  await render(['ses_a', 'ses_b']);
  await render([]);
  const baseline = history.getRetainedCountsForTest(directory);
  expect(baseline).toEqual({ seen: 2, metadata: 0, states: 0, timers: 1 });

  for (let cycle = 0; cycle < 100; cycle += 1) {
    const order = cycle % 2 === 0 ? ['ses_a', 'ses_b'] : ['ses_b', 'ses_a'];
    await render(order);
    // Unmount the first-mounted and the last-mounted consumer on alternate cycles.
    await render(cycle % 3 === 0 ? [order[0]!] : [order[1]!]);
    await render([]);
  }

  expect(history.getRetainedCountsForTest(directory)).toEqual(baseline);
  // With every consumer unmounted, the provider owner still materializes sessions.
  await history.ensureFirstPage({ directory, sessionID: 'ses_c' });
  expect(history.getMaterializationState({ directory, sessionID: 'ses_c' }).level).toBe('firstPageLoaded');
  await act(async () => root.unmount());
  history.dispose();
  loader.dispose();
  stores.disposeAll();
}));
