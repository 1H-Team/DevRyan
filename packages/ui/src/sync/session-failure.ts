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
  if (/local_execution_|mutation_runtime_|capture_timeout/.test(text)) return {
    code: 'local_execution_failed',
    message: 'Local tool execution could not start or finish. Review failed tools before sending another prompt.',
  };
  if (/TimeoutError|timed out|session_timeout/.test(`${error?.name ?? ''} ${text}`)) return {
    code: 'session_timeout', message: 'The request timed out. Review failed tools before continuing; their effects may be unknown.',
  };
  return { code: 'session_failed', message: 'The request failed. Review the conversation and failed tools before continuing.' };
}
