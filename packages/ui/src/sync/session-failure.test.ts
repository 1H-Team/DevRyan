import { describe, expect, test } from 'bun:test';
import { PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import { PROVIDER_TOKEN_EXPIRED_MESSAGE } from '@/lib/messages/providerTokenExpired';
import { describeSessionFailure } from './session-failure';

// The exact session.error Meridian produced when the Claude transport could not sign in.
const meridianSignInFailure = {
  name: 'APIError',
  data: {
    message: "Claude OAuth token has expired and could not be refreshed automatically. Run 'claude login' in your terminal to re-authenticate.",
  },
};

describe('describeSessionFailure', () => {
  test('names an expired provider sign-in instead of the generic failure', () => {
    const described = describeSessionFailure(meridianSignInFailure);
    expect(described).toEqual({ code: 'provider_token_expired', message: PROVIDER_TOKEN_EXPIRED_MESSAGE });
    expect(described.message).not.toContain('claude login');
  });

  test('names other provider authentication failures', () => {
    expect(describeSessionFailure({ name: 'APIError', data: { message: '401 Unauthorized' } }))
      .toEqual({ code: 'provider_auth_failed', message: PROVIDER_AUTH_FAILURE_MESSAGE });
    expect(describeSessionFailure({ name: 'UnknownError', data: {
      message: 'bot_opencode_provider_authentication: Reconnect the selected host OpenAI account in Providers and Bot Settings.',
    } })).toEqual({ code: 'provider_auth_failed', message: PROVIDER_AUTH_FAILURE_MESSAGE });
  });

  test('restores each classification from its persisted code alone', () => {
    for (const code of ['provider_token_expired', 'provider_auth_failed', 'session_timeout', 'session_cancelled']) {
      expect(describeSessionFailure({ code }).code).toBe(code);
    }
  });

  test('keeps timeout and unknown failures unchanged', () => {
    expect(describeSessionFailure({ name: 'UnknownError', data: { message: 'TimeoutError: The operation timed out.' } }).code)
      .toBe('session_timeout');
    expect(describeSessionFailure({ name: 'UnknownError', data: { message: 'Something else broke' } })).toEqual({
      code: 'session_failed',
      message: 'The request failed. Review the conversation and failed tools before continuing.',
    });
  });
});
