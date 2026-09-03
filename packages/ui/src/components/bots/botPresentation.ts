import type {
  BotActionAttempt,
  BotCapabilities,
  BotComputerControl,
  BotRun,
  BotRunFailurePhase,
} from '@/lib/botsApi';
import type { I18nKey } from '@/lib/i18n';

const runtimeFlag = (capabilities: BotCapabilities | null, name: string): boolean => (
  Boolean(capabilities?.runtime && capabilities.runtime[name] === true)
);

export const resolveBotRuntimeRecovery = (
  capabilities: BotCapabilities | null,
  desktopAvailable: boolean,
): 'setup' | 'repair' | 'update' | null => {
  if (!desktopAvailable || capabilities?.canManageRuntime !== true) return null;
  if (capabilities.state === 'setup_required' && runtimeFlag(capabilities, 'canSetup')) return 'setup';
  if (capabilities.state === 'image_update_available' && runtimeFlag(capabilities, 'canUpdate')) return 'update';
  if (capabilities.state === 'runtime_degraded' && runtimeFlag(capabilities, 'canRepair')) return 'repair';
  return null;
};

export type BotRuntimeWarning = { code: string; message: string };

const RUNTIME_WARNING_KEYS: Readonly<Record<string, I18nKey>> = {
  docker_memory_low: 'bots.runtime.warning.dockerMemoryLow',
  docker_memory_below_limits: 'bots.runtime.warning.dockerMemoryBelowLimits',
};

// Warnings ride along with a healthy runtime; they never change `state`.
export const resolveBotRuntimeWarnings = (
  capabilities: BotCapabilities | null,
): readonly BotRuntimeWarning[] => {
  const raw = capabilities?.runtime?.warnings;
  if (!Array.isArray(raw)) return [];
  const warnings: BotRuntimeWarning[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { code, message } = entry as Record<string, unknown>;
    if (typeof code !== 'string' || !code || typeof message !== 'string' || !message) continue;
    if (warnings.some((warning) => warning.code === code)) continue;
    warnings.push({ code, message });
    if (warnings.length === 5) break;
  }
  return warnings;
};

export const resolveBotRuntimeWarningMessageKey = (code: string): I18nKey | null => (
  RUNTIME_WARNING_KEYS[code] ?? null
);

export const resolveBotRuntimeMessageKey = (state: string, code?: string | null): I18nKey | null => {
  if (state === 'healthy') return null;
  // Another DevRyan installation on the same machine owns the Bot runtime;
  // "needs repair" would send the user into a repair that refuses to run.
  if (code === 'bot_runtime_foreign_deployment') return 'bots.runtime.foreignDeployment';
  if (state === 'docker_stopped') return 'bots.runtime.dockerStopped';
  if (state === 'docker_not_installed') return 'bots.runtime.dockerNotInstalled';
  if (state === 'setup_required') return 'bots.runtime.setupRequired';
  if (state === 'image_update_available') return 'bots.runtime.updateRequired';
  if (state === 'runtime_degraded') return 'bots.runtime.needsRepair';
  if (state === 'index_rebuilding') return 'bots.runtime.indexRebuilding';
  if (state === 'migration_required') return 'bots.runtime.migrationRequired';
  if (state === 'encryption_unavailable') return 'bots.runtime.encryptionUnavailable';
  return 'bots.runtime.unavailable';
};

export const shouldSubmitBotComposerKey = ({
  key,
  shiftKey,
  isComposing,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean => key === 'Enter' && !shiftKey && !isComposing;

export const buildBotRevisionMarkers = ({
  messageIds,
  runIdsByMessageId,
  revisionIdsByRunId,
  revisionNumbersById,
}: {
  messageIds: readonly string[];
  runIdsByMessageId: Readonly<Record<string, string | null>>;
  revisionIdsByRunId: Readonly<Record<string, string>>;
  revisionNumbersById: Readonly<Record<string, number>>;
}): Readonly<Record<string, number>> => {
  const markers: Record<string, number> = {};
  let previousRevisionId: string | null = null;
  for (const messageId of messageIds) {
    const runId = runIdsByMessageId[messageId];
    const revisionId = runId ? revisionIdsByRunId[runId] ?? null : null;
    if (!revisionId || revisionId === previousRevisionId) continue;
    previousRevisionId = revisionId;
    const revisionNumber = revisionNumbersById[revisionId];
    if (revisionNumber !== undefined) markers[messageId] = revisionNumber;
  }
  return markers;
};

export const botRunLabelKey = (state: BotRun['state']) => `bots.run.${state}` as const;

export const describeBotActionTarget = (action: BotActionAttempt): string => {
  for (const key of ['origin', 'host', 'resource', 'goal', 'name']) {
    const value = action.target[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return action.tool;
};

export type BotApprovalAccess = {
  allowed: boolean;
  blockedMessageKey: I18nKey | null;
};

export const resolveBotApprovalAccess = ({
  action,
  principalId,
  isMember,
}: {
  action: BotActionAttempt;
  principalId: string | null;
  isMember: boolean;
}): BotApprovalAccess => {
  if (!principalId || !isMember) {
    return {
      allowed: false,
      blockedMessageKey: 'bots.operations.approvals.membershipRequired',
    };
  }

  if (action.approvalClass === 'requester') {
    if (action.requiresDistinctApprover) {
      return {
        allowed: false,
        blockedMessageKey: 'bots.operations.approvals.requesterSeparationRequired',
      };
    }
    return action.initiatedBy === principalId
      ? { allowed: true, blockedMessageKey: null }
      : {
          allowed: false,
          blockedMessageKey: 'bots.operations.approvals.requesterRequired',
        };
  }

  if (action.approvalClass === 'operator') {
    if (action.requiresDistinctApprover && action.initiatedBy === principalId) {
      return {
        allowed: false,
        blockedMessageKey: 'bots.operations.approvals.distinctApproverRequired',
      };
    }
    return { allowed: true, blockedMessageKey: null };
  }

  if (action.approvalClass === 'manager') {
    if (action.requiresDistinctApprover && action.initiatedBy === principalId) {
      return {
        allowed: false,
        blockedMessageKey: 'bots.operations.approvals.distinctManagerRequired',
      };
    }
    return { allowed: true, blockedMessageKey: null };
  }

  return {
    allowed: false,
    blockedMessageKey: 'bots.operations.approvals.unavailable',
  };
};

export type BotControlPresentation = {
  active: boolean;
  ownedByViewer: boolean;
  actorLabel: string | null;
  expiresInSeconds: number | null;
};

export const resolveBotControlPresentation = ({
  control,
  principalId,
  now,
}: {
  control: BotComputerControl | null;
  principalId: string | null;
  now: number;
}): BotControlPresentation => {
  if (!control?.leaseId || !control.expiresAt || control.expiresAt <= now) {
    return { active: false, ownedByViewer: false, actorLabel: null, expiresInSeconds: null };
  }
  const ownedByViewer = control.actorId !== null && control.actorId === principalId;
  return {
    active: true,
    ownedByViewer,
    actorLabel: ownedByViewer
      ? 'you'
      : 'another operator',
    expiresInSeconds: Math.max(0, Math.ceil((control.expiresAt - now) / 1000)),
  };
};

const isAttachmentFailure = (code: string | null) => Boolean(code && (
  code.startsWith('bot_attachment_')
  || code.startsWith('bot_artifact_')
  || code.startsWith('bot_shared_file_')
  || code.startsWith('bot_object_')
));

// Provider-shaped codes the dispatcher also emits when the run never reached
// the model because its runtime (container, readiness, OAuth readiness, ...)
// did not come up. With a startup failure phase they describe the runtime.
const STARTUP_RUNTIME_FAILURE_CODES: ReadonlySet<string> = new Set([
  'bot_opencode_request_failed',
  'bot_opencode_request_aborted',
  'bot_agent_execution_lost',
  'bot_opencode_provider_unknown',
  'bot_opencode_api_retryable',
  'bot_agent_run_failed',
  'bot_opencode_start_timeout',
  'bot_opencode_request_timeout',
]);

export const resolveBotRunFailureMessageKey = (
  code: string | null,
  failurePhase: BotRunFailurePhase | null | undefined = null,
): I18nKey => {
  if (failurePhase === 'startup' && code && STARTUP_RUNTIME_FAILURE_CODES.has(code)) {
    return 'bots.chat.failure.runtimeStartup';
  }
  switch (code) {
    case 'bot_object_expired': return 'bots.chat.failure.reattach';
    case 'bot_shared_file_copy_failed':
    case 'bot_shared_file_copy_timeout':
    case 'bot_shared_file_integrity_failed':
    case 'bot_object_not_found': return 'bots.chat.failure.attachmentCopy';
    case 'bot_response_missing':
    case 'bot_response_incomplete':
    case 'bot_response_unverified': return 'bots.chat.failure.noAnswer';
    case 'bot_opencode_request_failed':
    case 'bot_opencode_request_aborted':
    case 'bot_agent_execution_lost':
    case 'bot_opencode_provider_unknown':
    case 'bot_opencode_api_retryable':
    case 'bot_opencode_message_aborted':
    case 'bot_opencode_run_failed':
    case 'bot_agent_run_failed': return 'bots.chat.failure.providerTransient';
    case 'bot_opencode_context_overflow': return 'bots.chat.failure.contextOverflow';
    case 'bot_opencode_output_length': return 'bots.chat.failure.outputLength';
    case 'bot_opencode_structured_output': return 'bots.chat.failure.structuredOutput';
    case 'bot_action_invalid':
    case 'bot_gateway_operation_unavailable': return 'bots.chat.failure.actionInvalid';
    case 'bot_approval_expired':
    case 'bot_action_denied': return 'bots.chat.failure.approvalExpired';
    case 'bot_run_context_missing':
    case 'bot_message_not_found': return 'bots.chat.failure.retryMissing';
    case 'bot_runtime_scope_busy': return 'bots.chat.failure.retryBusy';
    case 'bot_opencode_provider_authentication': return 'bots.chat.failure.authentication';
    case 'bot_oauth_coordinator_unavailable':
    case 'bot_oauth_runtime_update_required':
    case 'bot_oauth_refresh_unavailable':
    case 'bot_oauth_persistence_failed': return 'bots.chat.failure.runtimeUnavailable';
    case 'bot_compiled_config_conflict':
    case 'bot_compiled_config_invalid':
    case 'bot_runtime_scoped_file_invalid': return 'bots.chat.failure.configuration';
    case 'bot_opencode_content_filter': return 'bots.chat.failure.contentFilter';
    case 'bot_opencode_api_rejected': return 'bots.chat.failure.rejected';
    case 'bot_run_timeout':
    case 'bot_opencode_request_timeout': return 'bots.chat.failure.timeout';
    case 'bots_unavailable':
    case 'bot_runtime_docker_unavailable':
    case 'bot_agent_adapter_unavailable':
    case 'bot_runtime_supervisor_unavailable':
    case 'bot_browser_recovery_failed':
    case 'bot_opencode_start_timeout': return 'bots.chat.failure.runtimeUnavailable';
    default: return isAttachmentFailure(code)
      ? 'bots.chat.failure.attachments'
      : 'bots.chat.failure.generic';
  }
};
