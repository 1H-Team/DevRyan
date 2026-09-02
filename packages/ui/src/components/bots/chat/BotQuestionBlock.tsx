import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { QuestionOptionRow } from '@/components/chat/QuestionOptionRow';
import { Button } from '@/components/ui/button';
import type { BotQuestion } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBotChannelStore, type BotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';
import { selectBotCurrentRunId } from '../operations/selectBotCurrentRun';
import { answeredLabels, questionOptionKey } from './botQuestionAnswers';

type Props = {
  channelId: string;
  messageId: string;
  sequence: number;
  question: BotQuestion;
  channelStore?: BotChannelStore;
  operationsStore?: BotOperationsStore;
};

// Quick replies rendered inside the Bot's bubble, the way a messaging app
// shows suggested answers: tapping one sends a normal reply.
export const BotQuestionBlock: React.FC<Props> = ({
  channelId,
  messageId,
  sequence,
  question,
  channelStore = useBotChannelStore,
  operationsStore = useBotOperationsStore,
}) => {
  const { t } = useI18n();
  const reply = channelStore(useShallow((state) => {
    for (const id of state.messageIdsByChannelId[channelId] ?? []) {
      const message = state.messagesById[id];
      if (!message || message.role !== 'user' || message.sequence <= sequence) continue;
      return message.body.text;
    }
    return null;
  }));
  const sending = channelStore((state) => state.pendingMessageIdByChannelId[channelId] !== undefined);
  const busy = operationsStore((state) => selectBotCurrentRunId(state, channelId) !== null);
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const answered = reply !== null;
  const chosen = React.useMemo(() => answeredLabels(reply, question), [reply, question]);
  const disabled = answered || sending || busy;

  const send = (text: string) => {
    void channelStore.getState().sendQuickReply(channelId, text).catch(() => undefined);
  };

  return (
    <div
      className={cn('mt-2.5 border-t border-border/50 pt-2.5', answered && 'opacity-80')}
      role="group"
      aria-label={t('bots.chat.question.aria')}
      data-bot-question={messageId}
      data-bot-question-answered={answered ? 'true' : 'false'}
    >
      <div className="flex flex-col gap-0.5">
        {question.options.map((option) => {
          const key = questionOptionKey(option.label);
          const isSelected = answered ? chosen.has(key) : selected.includes(option.label);
          return (
            <QuestionOptionRow
              key={option.label}
              label={option.label}
              description={option.description ?? ''}
              selected={isSelected}
              multiple={question.multiple}
              disabled={disabled}
              recommended={false}
              recommendedLabel=""
              onSelect={() => {
                if (disabled) return;
                if (!question.multiple) {
                  send(option.label);
                  return;
                }
                setSelected((current) => (current.includes(option.label)
                  ? current.filter((label) => label !== option.label)
                  : [...current, option.label]));
              }}
            />
          );
        })}
      </div>
      {question.multiple && !answered ? (
        <div className="mt-1.5 flex items-center gap-2 px-1.5">
          <Button
            type="button"
            size="xs"
            disabled={disabled || selected.length === 0}
            onClick={() => send(selected.join(', '))}
          >
            {t('bots.chat.question.send')}
          </Button>
        </div>
      ) : null}
      {!answered && question.allowFreeText ? (
        <p className="mt-1 px-1.5 typography-micro text-muted-foreground">{t('bots.chat.question.freeText')}</p>
      ) : null}
      {answered ? (
        <p className="mt-1 px-1.5 typography-micro text-muted-foreground" data-bot-question-reply="true">
          {t('bots.chat.question.answered')}: {reply}
        </p>
      ) : null}
    </div>
  );
};
