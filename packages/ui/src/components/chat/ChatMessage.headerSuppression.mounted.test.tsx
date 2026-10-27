import type { StreamPhase } from './message/types';
import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom } from '@/test/mountedDom';
import type { ChatMessageEntry } from './lib/turns/types';

const config = create(() => ({ providers: [{ id: 'openai', models: [{ id: 'gpt-6-sol', name: 'GPT-6 Sol', variants: {} }] }], currentVariant: 'medium' }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: config }));
mock.module('@/stores/useFeatureFlagsStore', () => ({ useFeatureFlagsStore: create(() => ({ planModeEnabled: false })) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: create(() => ({ showReasoningTraces: true, stickyUserHeader: false })) }));
mock.module('@/stores/contextStore', () => ({ useContextStore: create(() => ({ currentAgentContext: new Map(), sessionAgentSelections: new Map() })) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: create(() => ({ currentSessionId: 'session', sessionAbortFlags: new Map(), isUserMessagePlanMode: () => false })) }));
mock.module('@/sync/selection-store', () => ({ useSelectionStore: create(() => ({ getAgentModelForSession: () => null, getSessionModelSelection: () => null })) }));
mock.module('@/sync/session-actions', () => ({ revertToMessage: () => {}, forkFromMessage: () => {} }));
mock.module('@/components/ui', () => ({ toast: {} }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchInput: false }) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' } } }) }));
mock.module('@/lib/theme/syntaxThemeGenerator', () => ({ generateSyntaxTheme: () => ({}) }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ hasLogo: false, src: null, onError: () => {} }) }));
mock.module('./message/MessageBody', () => ({ default: () => <p>Assistant body.</p> }));
const { default: ChatMessage } = await import('./ChatMessage');

const user: ChatMessageEntry = { info: {
  id: 'user', sessionID: 'session', role: 'user', time: { created: 1 }, agent: 'orchestrator',
  model: { providerID: 'openai', modelID: 'gpt-6-sol' },
}, parts: [] };
const assistant = (completed: boolean): ChatMessageEntry => ({ info: {
  id: 'assistant', sessionID: 'session', role: 'assistant', parentID: 'user', agent: 'orchestrator',
  modelID: 'gpt-6-sol', providerID: 'openai', mode: 'orchestrator',
  path: { cwd: '/fixture', root: '/fixture' }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: completed ? { created: 2, completed: 3 } : { created: 2 }, ...(completed ? { finish: 'stop' } : {}),
}, parts: [{ id: 'text', sessionID: 'session', messageID: 'assistant', type: 'text', text: 'Assistant body.' }] });

const hasHeader = (container: { textContent: string }) => container.textContent.includes('Orchestrator');

test('suppressing the header hides it and un-suppressing restores it (memo comparator sees the prop)', async () => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const render = (suppressAssistantHeader: boolean, headerMessageId: string | undefined = 'assistant') =>
      act(async () => root.render(<ChatMessage message={assistant(true)} previousMessage={user}
        isLatestMessage assistantHeaderMessageId={headerMessageId} suppressAssistantHeader={suppressAssistantHeader} />));
    try {
      await render(false);
      expect(hasHeader(container)).toBe(true);
      await render(true);
      expect(hasHeader(container)).toBe(false);
      await render(true, undefined);
      expect(hasHeader(container)).toBe(false);
      await render(false);
      expect(hasHeader(container)).toBe(true);
    } finally { await act(async () => root.unmount()); }
  });
});

// Probe phase that is neither streaming nor completed: only the latched header
// (set while streaming) can make the header visible under it.
const notStreaming = 'queued' as unknown as StreamPhase;

test('a suppressed streaming row does not latch the header open for later', async () => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const render = (suppressAssistantHeader: boolean, phase: 'streaming' | typeof notStreaming) =>
      act(async () => root.render(<ChatMessage message={assistant(false)} previousMessage={user}
        isLatestMessage isInActiveTurn activeStreamingPhase={phase}
        assistantHeaderMessageId="assistant" suppressAssistantHeader={suppressAssistantHeader} />));
    try {
      await render(true, 'streaming');
      expect(hasHeader(container)).toBe(false);
      await render(false, notStreaming);
      expect(hasHeader(container)).toBe(false);
      await render(false, 'streaming');
      expect(hasHeader(container)).toBe(true);
      await render(false, notStreaming);
      expect(hasHeader(container)).toBe(true);
    } finally { await act(async () => root.unmount()); }
  });
});
