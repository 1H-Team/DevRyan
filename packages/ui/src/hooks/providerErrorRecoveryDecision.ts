import type { Message, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { isDefiniteProviderUsageLimit } from '@devryan/orchestration-runtime';

import { isLikelyProviderAuthFailure } from '@/lib/messages/providerAuthError';
import { isLikelyProviderModelNotFound } from '@/lib/messages/providerModelNotFound';
import { isLikelyTransientStreamFailure, stripWrappedJsonQuotes } from '@/lib/messages/transientStreamError';
import { isAssistantTurnComplete } from '@/sync/session-working';
import { isClaudeThirdPartyUsageClassificationError } from '@/lib/messages/claudeThirdPartyUsage';
import { decodeAssistantMessageError } from '@/lib/decoders/assistantMessageError';

type Input = {
  messages: Message[];
  observedActiveUserMessageId?: string;
  queuedMessageCount: number;
  blockingRequestCount: number;
};

export const MAX_TRANSIENT_PROVIDER_RETRY_ATTEMPTS = 3;
// OpenCode 2 bounds its own transient retries (up to 10, 2-10 s backoff), so a
// retry loop is only stopped here once it has also outlasted this window.
export const MAX_TRANSIENT_PROVIDER_RETRY_WINDOW_MS = 5 * 60_000;
export const INTERRUPTED_PROVIDER_RESPONSE_REASON = 'The previous response stopped before it completed.';

export function isPrimaryProviderRecoverySession(
  session: { parentID?: string | null } | undefined,
): boolean {
  return Boolean(session && !session.parentID);
}

export function decideProviderRetryLoopRecovery(
  status: SessionStatus | undefined,
  retryElapsedMs = 0,
): { reason: string } | null {
  if (status?.type !== 'retry') return null;
  const reason = stripWrappedJsonQuotes(status.message).trim();
  if (!reason) return null;
  if (
    isClaudeThirdPartyUsageClassificationError(reason)
    || isDefiniteProviderUsageLimit(reason)
  ) return { reason };
  if (status.attempt < MAX_TRANSIENT_PROVIDER_RETRY_ATTEMPTS) return null;
  if (retryElapsedMs < MAX_TRANSIENT_PROVIDER_RETRY_WINDOW_MS) return null;
  if (!isLikelyTransientStreamFailure(undefined, reason)) return null;
  return { reason };
}

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

  const error = decodeAssistantMessageError(latest.error);
  const reason = stripWrappedJsonQuotes(error?.detail ?? '').trim();
  if (!reason || isLikelyProviderAuthFailure(reason)) return null;
  if (
    isClaudeThirdPartyUsageClassificationError(reason)
    ||
    isLikelyProviderModelNotFound(reason)
    || error?.name === 'ProviderModelNotFoundError'
    || isLikelyTransientStreamFailure(error?.name, reason)
  ) return { reason };
  return null;
}

export function decideInterruptedProviderRecovery(
  input: Pick<Input, 'messages' | 'queuedMessageCount' | 'blockingRequestCount'>,
): { reason: string } | null {
  if (input.queuedMessageCount > 0 || input.blockingRequestCount > 0) return null;
  const latest = input.messages.at(-1);
  if (!latest || latest.role !== 'assistant' || latest.error || isAssistantTurnComplete(latest)) {
    return null;
  }

  for (let index = input.messages.length - 2; index >= 0; index -= 1) {
    if (input.messages[index]?.role === 'user') {
      return { reason: INTERRUPTED_PROVIDER_RESPONSE_REASON };
    }
  }
  return null;
}
