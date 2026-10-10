import { describe, expect, test } from 'bun:test';
import { PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import { PROVIDER_TOKEN_EXPIRED_MESSAGE } from '@/lib/messages/providerTokenExpired';
import { describeSessionFailure, type SessionFailure } from './session-failure';

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

  test('explains the native credential fence without claiming tool failure', () => {
    const described = describeSessionFailure({ name: 'UnknownError', data: {
      message: 'DevRyan refused credential.provider: native_credential_changed',
    } });
    expect(described).toEqual({
      code: 'provider_credentials_changed',
      message: 'The provider account changed while this request was being prepared. Check the selected account in Providers, then retry.',
    });
    expect(describeSessionFailure({ code: described.code })).toEqual(described);
  });

  test('restores each classification from its persisted code alone', () => {
    for (const code of ['provider_token_expired', 'provider_auth_failed', 'provider_credentials_changed', 'provider_quota_exceeded',
      'provider_request_unsupported', 'provider_rate_limited', 'provider_transport_failed', 'session_timeout', 'session_cancelled']) {
      expect(describeSessionFailure({ code }).code).toBe(code);
    }
  });

  test('uses bounded provider evidence and restores its classification', () => {
    const cases: Array<[NonNullable<SessionFailure['data']>, string]> = [
    [{ v2Type: 'provider.auth' }, 'provider_auth_failed'],
    [{ statusCode: 401 }, 'provider_auth_failed'],
    [{ providerCode: 'chatpass_v2_scope_not_authorized' }, 'provider_auth_failed'],
    [{ providerCode: 'subscription_sharing_invalid_user' }, 'provider_auth_failed'],
    [{ v2Type: 'provider.quota' }, 'provider_quota_exceeded'],
    [{ providerCode: 'subscription_sharing_usage_limit_exceeded' }, 'provider_quota_exceeded'],
    [{ v2Type: 'provider.unsupported-operation' }, 'provider_request_unsupported'],
    [{ providerCode: 'subscription_sharing_unsupported_capability', providerParam: 'tools' }, 'provider_request_unsupported'],
    [{ providerCode: 'subscription_sharing_route_not_supported', statusCode: 403, v2Type: 'provider.auth', message: '403 Forbidden' }, 'provider_request_unsupported'],
    [{ providerCode: 'subscription_sharing_user_not_eligible', statusCode: 403, v2Type: 'provider.auth' }, 'provider_request_unsupported'],
    [{ v2Type: 'provider.transport' }, 'provider_transport_failed'],
    [{ v2Type: 'provider.timeout' }, 'provider_transport_failed'],
    [{ v2Type: 'provider.invalid-output', message: 'Failed to read openai/openai-responses stream' }, 'provider_transport_failed'],
    [{ message: 'chatgpt_siwc_stream_incomplete' }, 'provider_transport_failed'],
    [{ v2Type: 'provider.rate-limit' }, 'provider_rate_limited'],
    ];
    for (const [data, code] of cases) {
      const described = describeSessionFailure({ name: 'UnknownError', data });
      expect(described.code).toBe(code);
      expect(describeSessionFailure({ code })).toEqual(described);
    }
  });

  test('does not echo provider body details or blame transport for unrelated structured output', () => {
    expect(describeSessionFailure({ data: { providerCode: 'unsupported_parameter', providerParam: 'tools', message: 'private prompt fixture' } }).message)
      .not.toContain('private prompt fixture');
    expect(describeSessionFailure({ data: { v2Type: 'provider.invalid-output', message: 'Invalid structured output' } }).code).toBe('session_failed');
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
