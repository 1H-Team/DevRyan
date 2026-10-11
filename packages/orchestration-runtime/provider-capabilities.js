const normalizeProviderId = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);
const normalizeAgentId = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

export const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED = 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED';
export const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE = 'Plan-mode managed tasks cannot use Cursor because this host cannot enforce read-only tool restrictions. Configure the parent Orchestrator or Plan agent with a non-Cursor model.';
export const MANAGED_READ_ONLY_AGENT_UNSUPPORTED = 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED';
export const MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE = 'Designer is implementation-only and cannot be dispatched from Plan Mode. Orchestrator owns design planning and may use Explorer for read-only discovery.';

/**
 * Managed read-only work relies on a deterministic per-prompt tool boundary.
 * Hosts may enable Cursor only when their managed execution path enforces it.
 */
export const supportsManagedReadOnlyProvider = (providerId, { cursorReadOnly = false } = {}) => {
  const normalizedProviderId = normalizeProviderId(providerId);
  return Boolean(normalizedProviderId) && (normalizedProviderId !== 'cursor-acp' || cursorReadOnly === true);
};

/**
 * Designer owns implementation and its visible validation. Plan-mode discovery
 * remains available to read-only specialists such as Explorer.
 */
export const supportsManagedReadOnlyAgent = (agent) => {
  const normalizedAgentId = normalizeAgentId(agent);
  return Boolean(normalizedAgentId) && normalizedAgentId !== 'designer';
};
