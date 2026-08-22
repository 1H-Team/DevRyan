import { describe, expect, test } from 'bun:test';

import { isClaudeThirdPartyUsageClassificationError } from './claudeThirdPartyUsage';

describe('isClaudeThirdPartyUsageClassificationError', () => {
  test('matches direct, JSON-wrapped, and stderr-appended classifier errors', () => {
    const phrase = 'Third-party apps now draw from your extra usage, not your plan limits.';
    expect(isClaudeThirdPartyUsageClassificationError(phrase)).toBe(true);
    expect(isClaudeThirdPartyUsageClassificationError(
      JSON.stringify({ type: 'api_error', message: `Claude Code returned an error result: API Error: 400 ${phrase}` }),
    )).toBe(true);
    expect(isClaudeThirdPartyUsageClassificationError(
      `${phrase} Subprocess stderr: Warning: Custom betas are only available for API key users.`,
    )).toBe(true);
  });

  test('does not match genuine quota errors or near misses', () => {
    expect(isClaudeThirdPartyUsageClassificationError("You've hit your limit · resets at 1:30am")).toBe(false);
    expect(isClaudeThirdPartyUsageClassificationError('Third-party applications use a different quota.')).toBe(false);
    expect(isClaudeThirdPartyUsageClassificationError(undefined)).toBe(false);
  });
});
