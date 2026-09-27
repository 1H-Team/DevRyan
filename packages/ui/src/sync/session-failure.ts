import { describeExecutionFailure } from '@/lib/executionFailure';
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import { isLikelyProviderTokenExpired, PROVIDER_TOKEN_EXPIRED_MESSAGE } from '@/lib/messages/providerTokenExpired';
export type SessionFailure = {
  code?: string;
  message?: string;
  name?: string;
  data?: { message?: string };
};

export const isSessionCancellation = (error?: SessionFailure): boolean =>
  error?.name === 'AbortError' || error?.name === 'MessageAbortedError' || error?.code === 'session_cancelled';

// Persist and render bounded classifications, never raw stacks, tool inputs or
// provider response bodies. A generic timeout does not establish provider blame.
export function describeSessionFailure(error?: SessionFailure): { code: string; message: string } {
  if (isSessionCancellation(error)) return { code: 'session_cancelled', message: 'Request cancelled.' };
  const text = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.data?.message ?? ''}`;
  const execution = describeExecutionFailure(text);
  if (execution) return { code: 'local_execution_failed', message: execution };
  if (/local_execution_|mutation_runtime_|capture_timeout/.test(text)) return {
    code: 'local_execution_failed',
    message: 'Local tool execution could not start or finish. Review failed tools before sending another prompt.',
  };
  // Persistence keeps only the code, so each provider class must round-trip from it.
  // Token expiry is checked first: the broader auth heuristic would swallow it.
  if (error?.code === 'provider_token_expired' || isLikelyProviderTokenExpired(text)) {
    return { code: 'provider_token_expired', message: PROVIDER_TOKEN_EXPIRED_MESSAGE };
  }
  if (error?.code === 'provider_auth_failed' || isLikelyProviderAuthFailure(text)) {
    return { code: 'provider_auth_failed', message: PROVIDER_AUTH_FAILURE_MESSAGE };
  }
  if (/TimeoutError|timed out|session_timeout/.test(`${error?.name ?? ''} ${text}`)) return {
    code: 'session_timeout', message: 'The request timed out. Review failed tools before continuing; their effects may be unknown.',
  };
  return { code: 'session_failed', message: 'The request failed. Review the conversation and failed tools before continuing.' };
}
