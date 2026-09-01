import type {
  BotActionAttempt,
  BotCapabilities,
  BotComputerControl,
  BotRun,
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

export const resolveBotRuntimeMessageKey = (state: string): I18nKey | null => {
  if (state === 'healthy') return null;
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
