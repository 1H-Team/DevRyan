import type { Message } from '@opencode-ai/sdk/v2/client';

import { isLikelyProviderAuthFailure } from '@/lib/messages/providerAuthError';
import { isLikelyProviderModelNotFound } from '@/lib/messages/providerModelNotFound';
import { isLikelyTransientStreamFailure, stripWrappedJsonQuotes } from '@/lib/messages/transientStreamError';

type Input = {
  messages: Message[];
  observedActiveUserMessageId?: string;
  queuedMessageCount: number;
  blockingRequestCount: number;
};

export function decideProviderErrorRecovery(input: Input): { reason: string } | null {
  if (input.queuedMessageCount > 0 || input.blockingRequestCount > 0) return null;
  const latest = input.messages.at(-1);
  if (!latest || latest.role !== 'assistant' || !latest.error) return null;

  let anchorUserMessageId: string | undefined;
  for (let index = input.messages.length - 2; index >= 0; index -= 1) {
    if (input.messages[index]?.role === 'user') {
      anchorUserMessageId = input.messages[index].id;
      break;
    }
  }
  if (!anchorUserMessageId || anchorUserMessageId !== input.observedActiveUserMessageId) return null;

  const error = latest.error as { name?: unknown; message?: unknown; data?: { message?: unknown } };
  const raw = typeof error.data?.message === 'string'
    ? error.data.message
    : typeof error.message === 'string'
      ? error.message
      : typeof error.name === 'string'
        ? error.name
        : '';
  const reason = stripWrappedJsonQuotes(raw).trim();
  if (!reason || isLikelyProviderAuthFailure(reason)) return null;
  if (
    isLikelyProviderModelNotFound(reason)
    || error.name === 'ProviderModelNotFoundError'
    || isLikelyTransientStreamFailure(error.name, reason)
  ) return { reason };
  return null;
}
