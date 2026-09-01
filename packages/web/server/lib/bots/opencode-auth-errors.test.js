import { describe, expect, it } from 'vitest';
import { classifyOpenCodeRunError } from './opencode-reasoning-adapter.js';

describe('Bot authentication diagnostics', () => {
  it.each([
    { name: 'UnknownError', data: { message: 'Token refresh failed: 401' } },
    { name: 'ProviderAuthError', data: { message: 'provider authentication failed', isRetryable: true } },
    { name: 'APIError', data: { statusCode: 401, isRetryable: true } },
    { name: 'UnknownError', data: { message: 'bot_opencode_provider_authentication: Reconnect the selected host OpenAI account in Providers and Bot Settings.' } },
  ])('classifies typed failures and the exact incident without retrying an accepted prompt', (error) => {
    expect(classifyOpenCodeRunError(error)).toMatchObject({ interruptionKind: 'bot_opencode_provider_authentication', retryable: false });
  });
  it.each(['server replied 401', 'Tool output: Token refresh failed: 401', 'Token refresh failed: 401\n',
    'Token refresh failed: 500', 'bot_opencode_provider_authentication: arbitrary text', 'An unrelated failure'])('does not guess authentication from %s', (message) => {
    expect(classifyOpenCodeRunError({ name: 'UnknownError', data: { message } }).interruptionKind).toBe('bot_opencode_provider_unknown');
  });
});
