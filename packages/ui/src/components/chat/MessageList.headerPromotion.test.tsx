import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { withDom } from '../bots/chat/botMountedDom';
import type { ChatMessageEntry } from './lib/turns/types';

type Probe = { id: string; owner?: string; suppress?: boolean };
let probes: Probe[] = [];

// Probe leaf: records what MessageList decides about header ownership while
// every other part of the list (grouping, projection, memo comparators) is real.
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ hasLogo: false, src: null, onError: () => {} }) }));
const realSyncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...realSyncContext,
  useEnsureSessionChildren: () => ({ isLoading: false, hasFetched: true }),
  useSessionChildren: () => [],
}));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('./ChatMessage', () => ({
  default: (props: {
    message: ChatMessageEntry; assistantHeaderMessageId?: string; suppressAssistantHeader?: boolean;
    turnGroupingContext?: { headerMessageId?: string };
  }) => {
    probes.push({ id: props.message.info.id, owner: props.assistantHeaderMessageId, suppress: props.suppressAssistantHeader });
    return <div data-probe={props.message.info.id} />;
  },
}));
const { default: MessageList } = await import('./MessageList');

const user: ChatMessageEntry = { info: { id: 'u1', sessionID: 's', role: 'user', time: { created: 1 }, agent: 'orchestrator',
  model: { providerID: 'p', modelID: 'm' } }, parts: [] } as unknown as ChatMessageEntry;
const assistant = (id: string, created: number, parts: ChatMessageEntry['parts']): ChatMessageEntry => ({ info: {
  id, sessionID: 's', role: 'assistant', parentID: 'u1', agent: 'orchestrator', modelID: 'm', providerID: 'p', mode: 'orchestrator',
  path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, completed: created + 1 }, finish: 'stop',
}, parts } as unknown as ChatMessageEntry);
const text = (messageID: string): ChatMessageEntry['parts'][number] =>
  ({ id: `${messageID}-t`, sessionID: 's', messageID, type: 'text', text: 'hello' }) as ChatMessageEntry['parts'][number];

const mountList = async (messages: ChatMessageEntry[]) => {
  probes = [];
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<MessageList sessionKey="s" turnStart={0} messages={messages}
        getAnimationHandlers={() => ({}) as never} hasMoreAbove={false} isLoadingOlder={false}
        onLoadOlder={() => {}} onMessageContentChange={() => {}} />));
    } finally { await act(async () => root.unmount()); }
  });
};
const last = (id: string) => [...probes].reverse().find((probe) => probe.id === id);

test('promotes the header past an empty leading assistant row', async () => {
  await mountList([user, assistant('a1', 2, []), assistant('a2', 4, [text('a2')])]);
  expect(last('a1')?.owner).toBe('a2');
  expect(last('a2')?.owner).toBe('a2');
  expect(last('a1')?.suppress).toBe(false);
});

test('suppresses the header on every row of a turn that renders nothing', async () => {
  await mountList([user, assistant('a1', 2, []), assistant('a2', 4, [])]);
  expect(last('a1')?.suppress).toBe(true);
  expect(last('a2')?.suppress).toBe(true);
});

test('suppresses the header on an ungrouped assistant row that renders nothing', async () => {
  await mountList([assistant('solo', 2, [])]);
  expect(last('solo')?.suppress).toBe(true);
});

test('keeps the header on an ungrouped assistant row with content', async () => {
  await mountList([assistant('solo', 2, [text('solo')])]);
  expect(last('solo')?.suppress).toBe(false);
});

const withError = (message: ChatMessageEntry): ChatMessageEntry => ({
  ...message, info: { ...message.info, error: { name: 'UnknownError', data: { message: 'boom' } } } as ChatMessageEntry['info'],
});
const readTool = (messageID: string): ChatMessageEntry['parts'][number] => ({
  id: `${messageID}-tool`, sessionID: 's', messageID, type: 'tool', callID: 'c1', tool: 'read',
  state: { status: 'completed', input: { filePath: '/a.ts' }, output: 'x', title: 'a.ts', metadata: {}, time: { start: 1, end: 2 } },
}) as ChatMessageEntry['parts'][number];

test('keeps the header for a turn whose only visible output is an error surface', async () => {
  await mountList([user, withError(assistant('a1', 2, []))]);
  expect(last('a1')?.suppress).toBe(false);
  expect(last('a1')?.owner).toBe('a1');
});

test('keeps the header for a turn whose only output is tool activity', async () => {
  await mountList([user, assistant('a1', 2, [readTool('a1')])]);
  expect(last('a1')?.suppress).toBe(false);
});

test('keeps the header for an empty row that is the live streaming row', async () => {
  probes = [];
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const streaming = { ...assistant('a1', 2, []), info: { ...assistant('a1', 2, []).info, time: { created: 2 }, finish: undefined } } as ChatMessageEntry;
    try {
      await act(async () => root.render(<MessageList sessionKey="s" turnStart={0} messages={[user, streaming]}
        sessionIsWorking activeStreamingMessageId="a1" activeStreamingPhase="streaming"
        getAnimationHandlers={() => ({}) as never} hasMoreAbove={false} isLoadingOlder={false}
        onLoadOlder={() => {}} onMessageContentChange={() => {}} />));
    } finally { await act(async () => root.unmount()); }
  });
  expect(last('a1')?.suppress).toBe(false);
});
