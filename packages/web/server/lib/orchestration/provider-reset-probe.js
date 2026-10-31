/**
 * The scheduler's `autoResume.resolveProviderReset` hook for the web/Electron
 * host. Claude runs through OpenCode's claude-agent provider, and Claude Code
 * reports its subscription windows on every turn (`rate_limit_event`); the native
 * host records the latest ones. This answers whether the account is limited and
 * when the limit lifts from that record, without any provider request. Every other
 * provider, or no recorded usage, answers null so planning falls back to the
 * OpenCode status hint and the backoff ladder.
 */
export const createClaudeAgentProviderResetProbe = ({ readUsage = () => undefined } = {}) => {
  const resolveProviderReset = async ({ providerId } = {}) => {
    if (providerId !== 'claude-agent') return null;
    let usage;
    try { usage = readUsage(); } catch { return null; }
    const windows = usage?.windows && typeof usage.windows === 'object' ? Object.values(usage.windows) : [];
    let limited = false, limitedResetAt = null, anyResetAt = null;
    for (const window of windows) {
      const resetAt = Number.isSafeInteger(window?.resetsAt) ? window.resetsAt * 1000 : null;
      if (resetAt !== null) anyResetAt = anyResetAt === null ? resetAt : Math.min(anyResetAt, resetAt);
      if (window?.status !== 'rejected' && !(typeof window?.utilization === 'number' && window.utilization >= 1)) continue;
      limited = true;
      if (resetAt !== null) limitedResetAt = limitedResetAt === null ? resetAt : Math.min(limitedResetAt, resetAt);
    }
    if (!windows.length) return null;
    return { limited, resetAt: limited ? limitedResetAt : anyResetAt };
  };
  return Object.freeze({ resolveProviderReset });
};
