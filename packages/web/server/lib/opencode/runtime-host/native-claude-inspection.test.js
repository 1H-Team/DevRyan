import { describe, expect, it } from 'vitest';

import { isClaudeAccountAbsent, unavailableClaudeInspection } from './native-claude-inspection.js';

describe('unavailable Claude quota inspection', () => {
  it('is not configured only when no usable account exists', () => {
    for (const code of ['claude_credentials_missing', 'native_claude_external_unavailable', 'native_claude_update_required']) {
      expect(isClaudeAccountAbsent(code)).toBe(true);
      expect(unavailableClaudeInspection('quota', code)).toMatchObject({ ok: false, configured: false, errorCode: code });
    }
    for (const code of ['claude_credentials_expired', 'native_claude_account_ambiguous', 'native_claude_refresh_failed', 'native_claude_quota_unavailable']) {
      expect(isClaudeAccountAbsent(code)).toBe(false);
      expect(unavailableClaudeInspection('quota', code)).toMatchObject({ ok: false, configured: true, errorCode: code });
    }
  });

  it('gives short messages for expired and ambiguous accounts and keeps the status shape', () => {
    expect(unavailableClaudeInspection('quota', 'native_claude_account_ambiguous').error)
      .toBe('More than one Claude account is connected. Usage needs a single selected account.');
    expect(unavailableClaudeInspection('quota', 'claude_credentials_expired').error)
      .toBe('The Claude sign-in has expired. Sign in again to see usage.');
    expect(unavailableClaudeInspection('status', 'claude_credentials_expired')).toEqual({
      installed: true, path: null, loggedIn: false, authStatus: 'unavailable', errorCode: 'claude_credentials_expired', error: 'Selected Claude account is unavailable.',
    });
  });
});
