const normalizeProviderId = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);
const normalizeAgentId = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

export const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED = 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED';
export const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE = 'Plan-mode managed tasks cannot use Cursor because its SDK does not expose enforceable per-prompt write restrictions. Configure the parent Orchestrator or Plan agent with a non-Cursor model.';
export const MANAGED_READ_ONLY_AGENT_UNSUPPORTED = 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED';
export const MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE = 'Designer is implementation-only and cannot be dispatched from Plan Mode. Orchestrator owns design planning and may use Explorer for read-only discovery.';

/**
 * Managed read-only work relies on a deterministic per-prompt tool boundary.
 * Cursor's SDK does not currently expose one, so it must be routed elsewhere
 * before the task enters the durable scheduler.
 */
export const supportsManagedReadOnlyProvider = (providerId) => {
  const normalizedProviderId = normalizeProviderId(providerId);
  return Boolean(normalizedProviderId) && normalizedProviderId !== 'cursor-acp';
};

/**
 * Designer owns implementation and its visible validation. Plan-mode discovery
 * remains available to read-only specialists such as Explorer.
 */
export const supportsManagedReadOnlyAgent = (agent) => {
  const normalizedAgentId = normalizeAgentId(agent);
  return Boolean(normalizedAgentId) && normalizedAgentId !== 'designer';
};
