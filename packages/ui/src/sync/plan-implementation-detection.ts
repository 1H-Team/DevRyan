import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import {
  getPlanBlockId,
  getPlanImplementationKey,
  parsePlanImplementationRequestPart,
  resolveMessagePlanCard,
} from '@/lib/messages/actionablePlan';
import { filterMessagesForRevert, getEffectiveSessionRevertMessageID } from './revert-transactions';
import type { State } from './types';

export type PlanImplementationRequestCandidate = {
  sourceSessionId: string;
  sourceMessageId: string;
  implementationMessageId: string;
  implementationKey: string;
};

type PlanImplementationDetectionState = Pick<
  State,
  'message' | 'part' | 'revert_transaction'
>;

const hasMatchingPlanCard = (
  state: PlanImplementationDetectionState,
  message: Message,
  planIndex: number,
): boolean => {
  if (message.role !== 'assistant' || planIndex !== 0) return false;
  const split = resolveMessagePlanCard(state.part[message.id] ?? [], { isPlanModeSource: true });
  return Boolean(split && split.planText.trim().length > 0);
};

export function detectPlanImplementationRequestCandidate({
  sessionID,
  state,
}: {
  sessionID: string;
  state: PlanImplementationDetectionState;
}): PlanImplementationRequestCandidate | null {
  const rawMessages = state.message[sessionID];
  if (!rawMessages || rawMessages.length === 0) return null;

  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID);
  const messages = filterMessagesForRevert(rawMessages, revertMessageID);
  const messageIndexById = new Map(messages.map((message, index) => [message.id, index]));

  for (let implementationIndex = messages.length - 1; implementationIndex >= 0; implementationIndex -= 1) {
    const implementationMessage = messages[implementationIndex];
    if (implementationMessage.role !== 'user') continue;

    for (const part of state.part[implementationMessage.id] ?? []) {
      const request = parsePlanImplementationRequestPart(part as Part);
      if (!request || request.sourceSessionId !== sessionID) continue;

      const sourceIndex = messageIndexById.get(request.sourceMessageId);
      if (sourceIndex === undefined || sourceIndex >= implementationIndex) continue;
      const sourceMessage = messages[sourceIndex];
      if (!hasMatchingPlanCard(state, sourceMessage, request.planIndex)) continue;

      return {
        sourceSessionId: request.sourceSessionId,
        sourceMessageId: request.sourceMessageId,
        implementationMessageId: implementationMessage.id,
        implementationKey: getPlanImplementationKey(
          request.sourceSessionId,
          getPlanBlockId(request.sourceMessageId, request.planIndex),
        ),
      };
    }
  }

  return null;
}
