import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom } from '../bots/chat/botMountedDom';
import type { ChatMessageEntry, TurnGroupingContext } from './lib/turns/types';
import { resolveUserMessageVariant } from '@/sync/subtask-agent';

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
// Keep the real primary row, header, badge, resolver and memo comparators.
mock.module('./message/MessageBody', () => ({ default: () => <p>Reading plan and skill.</p> }));
const { default: ChatMessage } = await import('./ChatMessage');

const user = (variant?: string): ChatMessageEntry => ({ info: {
  id: 'user', sessionID: 'session', role: 'user', time: { created: 1 }, agent: 'orchestrator',
  model: { providerID: 'openai', modelID: 'gpt-6-sol', ...(variant === undefined ? {} : { variant }) },
}, parts: [] });
const assistant: ChatMessageEntry = { info: {
  id: 'assistant', sessionID: 'session', role: 'assistant', parentID: 'user', agent: 'orchestrator',
  modelID: 'gpt-6-sol', providerID: 'openai', mode: 'orchestrator',
  path: { cwd: '/fixture', root: '/fixture' }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2 },
}, parts: [{ id: 'text', sessionID: 'session', messageID: 'assistant', type: 'text', text: 'Reading plan and skill.' }] };

for (const grouped of [false, true]) {
  test(`primary thinking survives metadata arrival, completion and reload (${grouped ? 'grouped' : 'standalone'})`, async () => {
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      let previousMessage = user();
      let message = assistant;
      const render = async () => {
        const context: TurnGroupingContext | undefined = grouped ? {
          turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
          hasTools: false, hasReasoning: false, headerMessageId: 'assistant',
          isWorking: true, isTurnWorking: true,
          userMessageVariant: resolveUserMessageVariant(previousMessage.info),
        } : undefined;
        await act(async () => root.render(<ChatMessage message={message} previousMessage={previousMessage}
          isLatestMessage isInActiveTurn activeStreamingPhase="streaming" turnGroupingContext={context} />));
      };
      const badge = () => container.find((node) => node.getAttribute('title') === 'GPT-6 Sol High');
      try {
        await render();
        expect(badge()).toBeNull();
        previousMessage = user('high');
        await render();
        expect(badge()).not.toBeNull();
        expect(container.textContent).toContain('Orchestrator');
        await act(async () => config.setState({ currentVariant: 'low' }));
        expect(badge()).not.toBeNull();
        if (message.info.role !== 'assistant') throw new Error('Expected assistant fixture');
        message = { ...message, info: { ...message.info, finish: 'stop', time: { created: 2, completed: 3 } } };
        await render();
        expect(badge()).not.toBeNull();
        await act(async () => root.render(null));
        previousMessage = structuredClone(previousMessage);
        message = structuredClone(message);
        await render();
        expect(badge()).not.toBeNull();
        previousMessage = user('');
        await render();
        expect(badge()).toBeNull();
        expect(container.find((node) => node.getAttribute('title') === 'GPT-6 Sol')).not.toBeNull();
      } finally {
        await act(async () => root.unmount());
      }
    });
  });
}
