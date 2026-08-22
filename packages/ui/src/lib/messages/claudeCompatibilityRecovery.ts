import { setClaudeCompatibilityMode } from '@/lib/claudePromptModeApi';
import { isAnthropicOAuthProviderId } from '@/lib/providers/display';

import { isClaudeThirdPartyUsageClassificationError } from './claudeThirdPartyUsage';

export function requiresClaudeCompatibilityRecovery(
  reason: unknown,
  selectedProviderId: string | null | undefined,
): boolean {
  return isClaudeThirdPartyUsageClassificationError(reason)
    && isAnthropicOAuthProviderId(selectedProviderId);
}

export async function prepareClaudeCompatibilityRecovery(
  reason: unknown,
  selectedProviderId: string | null | undefined,
  setCompatibilityMode = setClaudeCompatibilityMode,
): Promise<boolean> {
  if (!requiresClaudeCompatibilityRecovery(reason, selectedProviderId)) return false;
  await setCompatibilityMode(true);
  return true;
}

export async function executeClaudeAwareProviderRecovery<
  T extends { reason: unknown; selection: { providerId: string } },
>(
  input: T,
  executeRecovery: (input: T) => Promise<boolean>,
  setCompatibilityMode = setClaudeCompatibilityMode,
): Promise<boolean> {
  await prepareClaudeCompatibilityRecovery(
    input.reason,
    input.selection.providerId,
    setCompatibilityMode,
  );
  return await executeRecovery(input);
}
