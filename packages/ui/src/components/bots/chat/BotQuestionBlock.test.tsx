import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotMessage, BotQuestion } from '@/lib/botsApi';
import { createBotChannelStore } from '@/stores/useBotChannelStore';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { BotQuestionBlock } from './BotQuestionBlock';
import { answeredLabels } from './botQuestionAnswers';

const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'd0000000-0000-4000-8000-000000000001';
const QUESTION_MESSAGE_ID = 'e0000000-0000-4000-8000-000000000002';

const question: BotQuestion = {
  version: 1,
  prompt: 'Which plan?',
  options: [
    { label: 'Monthly', description: null },
    { label: 'Annual', description: 'Two months free' },
  ],
  multiple: false,
  allowFreeText: true,
};

const message = (id: string, sequence: number, role: 'user' | 'assistant', text: string, extra: Partial<BotMessage['body']> = {}): BotMessage => ({
  id,
  channelId: CHANNEL_ID,
  runId: 'f0000000-0000-4000-8000-000000000001',
  actorUserId: role === 'user' ? USER_ID : null,
  role,
  assistantPhase: role === 'assistant' ? 'result' : null,
  sequence,
  body: { text, attachmentIds: [], ...extra },
  attachmentCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  finalizedAt: '2026-09-01T00:00:00.000Z',
});

const render = (messages: BotMessage[]) => {
  const channelStore = createBotChannelStore({ getPrincipalId: () => USER_ID });
  channelStore.getState().resetPrincipal(USER_ID);
  channelStore.getState().replaceSnapshot({
    channels: [{
      id: CHANNEL_ID, botId: BOT_ID, ownerUserId: USER_ID, accessRole: 'owner', canSend: true,
      lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: messages.length,
      lastMessageAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      archivedAt: null,
    }],
  });
  for (const entry of messages) channelStore.getState().upsertMessage(entry);
  Object.assign(channelStore.getInitialState(), channelStore.getState());
  const operationsStore = createBotOperationsStore();
  return renderToStaticMarkup(
    <I18nProvider>
      <BotQuestionBlock
        channelId={CHANNEL_ID}
        messageId={QUESTION_MESSAGE_ID}
        sequence={2}
        question={question}
        channelStore={channelStore}
        operationsStore={operationsStore}
      />
    </I18nProvider>,
  );
};

describe('BotQuestionBlock', () => {
  test('renders tappable quick replies inside the bubble while the question is open', () => {
    const markup = render([
      message('e0000000-0000-4000-8000-000000000001', 1, 'user', 'Sign me up'),
      message(QUESTION_MESSAGE_ID, 2, 'assistant', '', { question }),
    ]);
    expect(markup).toContain('data-bot-question-answered="false"');
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('Monthly');
    expect(markup).toContain('Two months free');
    expect(markup).toContain('Or just type a reply');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('You answered');
  });

  test('locks the replies and shows the chosen one once the member has answered', () => {
    const markup = render([
      message('e0000000-0000-4000-8000-000000000001', 1, 'user', 'Sign me up'),
      message(QUESTION_MESSAGE_ID, 2, 'assistant', '', { question }),
      message('e0000000-0000-4000-8000-000000000003', 3, 'user', 'annual'),
    ]);
    expect(markup).toContain('data-bot-question-answered="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('You answered: annual');
    expect(markup).not.toContain('Or just type a reply');
    expect(answeredLabels('annual', question)).toEqual(new Set(['annual']));
    expect(answeredLabels('Monthly and Annual', { ...question, multiple: true })).toEqual(new Set(['monthly', 'annual']));
    expect(answeredLabels('something else', question)).toEqual(new Set());
  });
});
