export const CLAUDE_THIRD_PARTY_USAGE_PHRASE =
  'third-party apps now draw from your extra usage, not your plan limits';

export function isClaudeThirdPartyUsageClassificationError(value: unknown): boolean {
  return typeof value === 'string'
    && value.toLowerCase().includes(CLAUDE_THIRD_PARTY_USAGE_PHRASE);
}
