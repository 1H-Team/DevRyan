import type { BotCapabilitySummary } from './botEventConnection';

// The event stream reads the local Bot catalog, so it opens exactly when the
// catalog is available, independently of Docker execution. Older hosts
// without `catalogAvailable` keep the previous state-based rule.
export const botCapabilityCanStream = (capabilities: BotCapabilitySummary): boolean => (
  typeof capabilities.catalogAvailable === 'boolean'
    ? capabilities.catalogAvailable
    : ![
      'supabase_unavailable',
      'supabase_disconnected',
      'supabase_not_configured',
      'migration_required',
    ].includes(capabilities.state)
);

// States rechecked on owner action or focus. A stopped Docker host does not
// need a root capability retry loop while ordinary Agents are being used;
// an available catalog still opens its stream before this policy is consulted.
const FINAL_CAPABILITY_STATES = new Set([
  'unsupported_host',
  'database_recovery_required',
  'encryption_unavailable',
  'setup_required',
  'docker_not_installed',
  'docker_stopped',
  'supabase_disconnected',
  'supabase_not_configured',
]);
const RECOVERY_DATABASE_STATES = new Set(['recovery_required', 'setup_required', 'update_required']);

export const botCapabilityIsTransient = (capabilities: BotCapabilitySummary): boolean => (
  !FINAL_CAPABILITY_STATES.has(capabilities.state)
  && !RECOVERY_DATABASE_STATES.has(capabilities.database?.state ?? '')
);
