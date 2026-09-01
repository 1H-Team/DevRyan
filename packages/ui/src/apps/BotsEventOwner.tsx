import React from 'react';

import {
  type BotActionAttempt,
  type BotChannel,
  type BotChannelPreview,
  type BotComputerStatus,
  type BotEventEnvelope,
  type BotMembershipSummary,
  type BotMessage,
  type BotRevisionSummary,
  type BotRun,
  type BotSharedFile,
  type BotSnapshot,
  type BotStreamingMessage,
  type BotSummary,
} from '@/lib/botsApi';
import { hasAuthCapability, useAuthPrincipal } from '@/lib/authSession';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  type BotChannelStore,
  useBotChannelStore,
} from '@/stores/useBotChannelStore';
import {
  type BotOperationsStore,
  useBotOperationsStore,
} from '@/stores/useBotOperationsStore';
import {
  type BotSharedFilesStore,
  useBotSharedFilesStore,
} from '@/stores/useBotSharedFilesStore';
import { type BotsStore, useBotsStore } from '@/stores/useBotsStore';
import { useBotLiveMessageStore } from '@/stores/useBotLiveMessageStore';
import { useBotComputerActivityStore, type BotComputerActivity } from '@/stores/useBotComputerActivityStore';
import {
  createBotCapabilityConnectionController,
  createBotEventConnectionController,
  installBotEventConnection,
  releaseBotEventConnection,
  type BotEventSource,
} from './botEventConnection';

const BOT_EVENT_KINDS = Object.freeze([
  'snapshot',
  'bot.created',
  'bot.updated',
  'bot.activated',
  'bot.paused',
  'bot.retired',
  'bot.removed',
  'bot.purged',
  'revision.created',
  'revision.updated',
  'revision.activated',
  'membership.assigned',
  'membership.updated',
  'membership.revoked',
  'channel.created',
  'channel.updated',
  'channel.archived',
  'channel.revoked',
  'channel.removed',
  'message.created',
  'message.updated',
  'message.streaming',
  'run.queued',
  'run.started',
  'run.waiting_approval',
  'run.waiting_control',
  'run.control_resumed',
  'run.needs_reconciliation',
  'run.completed',
  'run.failed',
  'run.interrupted',
  'run.cancelled',
  'action.proposed',
  'action.pending_approval',
  'action.approved',
  'action.waiting_control',
  'action.control_resumed',
  'action.denied',
  'action.unknown',
  'action.failed',
  'action.succeeded',
  'action.reconciled',
  'action.cancelled',
  'memory.changed',
  'shared_file.updated',
  'computer.status',
  'computer.activity',
  'computer.control.take',
  'computer.control.heartbeat',
  'computer.control.return',
]);

type BotEventStores = {
  bots: BotsStore;
  channels: BotChannelStore;
  operations: BotOperationsStore;
  shared: BotSharedFilesStore;
  live?: typeof useBotLiveMessageStore;
};

export type BotEventCursor = Readonly<{
  epoch: string | null;
  sequence: number;
}>;

export type BotEventIngestResult = Readonly<{
  accepted: boolean;
  reason: 'snapshot' | 'event' | 'invalid' | 'wrong_epoch' | 'stale';
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasString = (record: Record<string, unknown>, key: string): boolean => (
  typeof record[key] === 'string'
);

const hasNullableString = (record: Record<string, unknown>, key: string): boolean => (
  record[key] === null || typeof record[key] === 'string'
);

const nullableStringOr = (value: unknown, fallback: string | null): string | null => {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
};

const markFinalBotResponse = (message: BotMessage): void => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.clearMarks?.('bot.final-response');
      performance.mark('bot.final-response');
      const name = `bot.final-response:${message.runId || message.id}`;
      performance.clearMarks?.(name);
      performance.mark(name);
    }
  } catch {
    // Instrumentation must never affect canonical reconciliation.
  }
};

const isComputerActivity = (value: unknown): value is BotComputerActivity => (
  isRecord(value) && typeof value.botId === 'string' && typeof value.channelId === 'string'
  && typeof value.runId === 'string' && Number.isSafeInteger(value.revision)
  && ['active', 'waiting', 'idle'].includes(String(value.state))
);

const parseBot = (value: unknown, previous?: BotSummary): BotSummary | null => {
  if (!isRecord(value)) return null;
  if (!hasString(value, 'id')
    || !hasString(value, 'name')
    || !['draft', 'active', 'paused', 'retired'].includes(String(value.lifecycle))
    || !['team', 'personalized'].includes(String(value.tenancy))
    || !hasNullableString(value, 'activeRevisionId')
    || !hasString(value, 'createdAt')
    || !hasString(value, 'updatedAt')
    || !hasNullableString(value, 'retiredAt')
    || (value.title !== undefined && typeof value.title !== 'string')
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || (value.avatarUrl !== undefined && !hasNullableString(value, 'avatarUrl'))
    || (value.avatarFallback !== undefined && !hasNullableString(value, 'avatarFallback'))) return null;
  return {
    id: String(value.id),
    name: String(value.name),
    title: typeof value.title === 'string' ? value.title : previous?.title ?? String(value.name),
    summary: typeof value.summary === 'string' ? value.summary : previous?.summary ?? '',
    avatarUrl: nullableStringOr(value.avatarUrl, previous?.avatarUrl ?? null),
    avatarFallback: nullableStringOr(value.avatarFallback, previous?.avatarFallback ?? null),
    lifecycle: value.lifecycle as BotSummary['lifecycle'],
    tenancy: value.tenancy as BotSummary['tenancy'],
    activeRevisionId: value.activeRevisionId as string | null,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    retiredAt: value.retiredAt as string | null,
  };
};

const isRevision = (value: unknown): value is BotRevisionSummary => {
  if (!isRecord(value)) return false;
  return hasString(value, 'id')
    && hasString(value, 'botId')
    && Number.isSafeInteger(value.revisionNumber)
    && hasString(value, 'compiledHash')
    && hasString(value, 'createdAt')
    && hasNullableString(value, 'activatedAt')
    && hasNullableString(value, 'retiredAt');
};

const isMembership = (value: unknown): value is BotMembershipSummary => {
  if (!isRecord(value)) return false;
  return hasString(value, 'botId')
    && hasString(value, 'userId')
    && hasString(value, 'role')
    && hasString(value, 'activatedAt')
    && hasNullableString(value, 'revokedAt')
    && hasString(value, 'updatedAt');
};

const isChannel = (value: unknown): value is BotChannel => {
  if (!isRecord(value)) return false;
  return hasString(value, 'id')
    && hasString(value, 'botId')
    && hasString(value, 'ownerUserId')
    && hasString(value, 'accessRole')
    && typeof value.canSend === 'boolean'
    && hasString(value, 'lifecycle')
    && Number.isSafeInteger(value.currentCheckpointNumber)
    && Number.isSafeInteger(value.lastMessageSequence)
    && hasNullableString(value, 'lastMessageAt')
    && hasString(value, 'createdAt')
    && hasString(value, 'updatedAt')
    && hasNullableString(value, 'archivedAt');
};

const isMessage = (value: unknown): value is BotMessage => {
  if (!isRecord(value) || !isRecord(value.body)) return false;
  return hasString(value, 'id')
    && hasString(value, 'channelId')
    && hasNullableString(value, 'runId')
    && hasNullableString(value, 'actorUserId')
    && hasString(value, 'role')
    && Number.isSafeInteger(value.sequence)
    && typeof value.body.text === 'string'
    && Array.isArray(value.body.attachmentIds)
    && value.body.attachmentIds.every((id) => typeof id === 'string')
    && Number.isSafeInteger(value.attachmentCount)
    && hasString(value, 'createdAt')
    && hasNullableString(value, 'finalizedAt');
};

const parseStreamingMessage = (value: unknown): BotStreamingMessage | null => {
  if (!isRecord(value)
    || !hasString(value, 'messageId')
    || !hasString(value, 'runId')
    || !hasString(value, 'channelId')
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || !hasString(value, 'createdAt')
    || typeof value.text !== 'string'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null;
  return {
    messageId: String(value.messageId),
    runId: String(value.runId),
    channelId: String(value.channelId),
    sequence: Number(value.sequence),
    createdAt: String(value.createdAt),
    text: value.text,
    revision: Number(value.revision),
  };
};

const isChannelPreview = (value: unknown): value is BotChannelPreview => {
  if (!isRecord(value)) return false;
  return hasString(value, 'channelId')
    && hasString(value, 'messageId')
    && ['user', 'assistant'].includes(String(value.role))
    && Number.isSafeInteger(value.sequence)
    && typeof value.text === 'string'
    && Number.isSafeInteger(value.attachmentCount)
    && hasString(value, 'createdAt')
    && hasNullableString(value, 'finalizedAt');
};

const isSharedFile = (value: unknown): value is BotSharedFile => {
  if (!isRecord(value)) return false;
  return hasString(value, 'id')
    && hasString(value, 'botId')
    && hasString(value, 'channelId')
    && hasString(value, 'messageId')
    && hasString(value, 'objectId')
    && hasNullableString(value, 'senderUserId')
    && ['user', 'bot'].includes(String(value.direction))
    && hasString(value, 'filename')
    && hasString(value, 'contentType')
    && hasNullableString(value, 'sha256')
    && (value.size === null || (Number.isSafeInteger(value.size) && Number(value.size) >= 0))
    && hasString(value, 'computerPath')
    && ['pending', 'copying', 'ready', 'failed'].includes(String(value.copyState))
    && hasNullableString(value, 'errorCode')
    && hasString(value, 'createdAt')
    && hasString(value, 'updatedAt');
};

const parseRun = (value: unknown): BotRun | null => {
  if (!isRecord(value)) return null;
  if (!(hasString(value, 'id')
    && hasString(value, 'botId')
    && hasString(value, 'channelId')
    && hasString(value, 'revisionId')
    && hasString(value, 'computerScopeKey')
    && hasString(value, 'state')
    && (value.interruptionKind === undefined || hasNullableString(value, 'interruptionKind'))
  )) return null;
  return {
    id: String(value.id),
    botId: String(value.botId),
    channelId: String(value.channelId),
    revisionId: String(value.revisionId),
    modelSnapshot: isRecord(value.modelSnapshot) ? value.modelSnapshot : null,
    computerScopeKey: String(value.computerScopeKey),
    queueSequence: Number.isSafeInteger(value.queueSequence) ? Number(value.queueSequence) : null,
    state: value.state as BotRun['state'],
    retryable: value.retryable === true,
    interruptionKind: nullableStringOr(value.interruptionKind, null),
    createdAt: nullableStringOr(value.createdAt, null),
    updatedAt: nullableStringOr(value.updatedAt, null),
    startedAt: nullableStringOr(value.startedAt, null),
    finishedAt: nullableStringOr(value.finishedAt, null),
  };
};

const isAction = (value: unknown): value is BotActionAttempt => {
  if (!isRecord(value)) return false;
  return hasString(value, 'id')
    && hasString(value, 'runId')
    && hasString(value, 'botId')
    && hasString(value, 'revisionId')
    && hasString(value, 'actionHash')
    && hasString(value, 'argsDigest')
    && hasString(value, 'state');
};

const isComputer = (value: unknown): value is BotComputerStatus => {
  if (!isRecord(value)) return false;
  return hasString(value, 'botId')
    && isRecord(value.browser)
    && isRecord(value.screencast)
    && value.framesRecorded === false;
};

const isComputerControl = (
  value: unknown,
): value is NonNullable<BotComputerStatus['control']> => {
  if (!isRecord(value)) return false;
  return hasNullableString(value, 'leaseId')
    && hasNullableString(value, 'actorId')
    && hasNullableString(value, 'actorType')
    && (value.takenAt === null || typeof value.takenAt === 'number')
    && (value.expiresAt === null || typeof value.expiresAt === 'number');
};

const arrayOf = <T,>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): readonly T[] | null => {
  const value = record[key];
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(guard) ? value : null;
};

const parsedArrayOf = <T,>(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | null,
): readonly T[] | null => {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const parsed: T[] = [];
  for (const entry of value) {
    const next = parse(entry);
    if (next === null) return null;
    parsed.push(next);
  }
  return parsed;
};

const parseSnapshot = (value: unknown): BotSnapshot | null => {
  if (!isRecord(value)) return null;
  const bots = parsedArrayOf(value, 'bots', parseBot);
  const revisions = arrayOf(value, 'revisions', isRevision);
  const memberships = arrayOf(value, 'memberships', isMembership);
  const channels = arrayOf(value, 'channels', isChannel);
  const channelPreviews = arrayOf(value, 'channelPreviews', isChannelPreview);
  const runs = parsedArrayOf(value, 'runs', parseRun);
  const recentActions = arrayOf(value, 'recentActions', isAction);
  const pendingApprovals = arrayOf(value, 'pendingApprovals', isAction);
  const computers = arrayOf(value, 'computers', isComputer);
  if (!bots || !revisions || !memberships || !channels || !channelPreviews || !runs || !recentActions || !pendingApprovals || !computers) {
    return null;
  }
  return { bots, revisions, memberships, channels, channelPreviews, runs, recentActions, pendingApprovals, computers };
};

const parseEnvelope = (value: unknown): BotEventEnvelope | null => {
  if (!isRecord(value)
    || !hasString(value, 'id')
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 0
    || !hasString(value, 'kind')
    || !isRecord(value.payload)) return null;
  return {
    id: value.id as string,
    sequence: Number(value.sequence),
    kind: value.kind as string,
    ...(typeof value.botId === 'string' ? { botId: value.botId } : {}),
    ...(typeof value.channelId === 'string' ? { channelId: value.channelId } : {}),
    payload: value.payload,
  };
};

const epochFromId = (id: string): string | null => {
  const separator = id.lastIndexOf(':');
  return separator > 0 ? id.slice(0, separator) : null;
};

const removeBotScopedState = (stores: BotEventStores, botId: string): void => {
  useBotComputerActivityStore.getState().removeBot(botId);
  stores.operations.getState().removeComputer(botId);
  stores.shared.getState().removeBot(botId);
  stores.bots.getState().removeMembership(botId);
  stores.bots.getState().removeBot(botId);
  const channelIds = Object.values(stores.channels.getState().channelsById)
    .filter((channel) => channel.botId === botId)
    .map((channel) => channel.id);
  for (const channelId of channelIds) {
    (stores.live ?? useBotLiveMessageStore).getState().clearChannel(channelId);
    stores.channels.getState().removeChannel(channelId);
  }
  const runIds = Object.values(stores.operations.getState().runsById)
    .filter((run) => run.botId === botId)
    .map((run) => run.id);
  for (const runId of runIds) stores.operations.getState().removeRun(runId);
};

const removeChannelScopedState = (stores: BotEventStores, channelId: string): void => {
  useBotComputerActivityStore.getState().removeChannel(channelId);
  const view = Object.values(stores.operations.getState().computerViewsByBotId)
    .find((entry) => entry.channelId === channelId);
  if (view) void stores.operations.getState().stopComputerView(view.botId).catch(() => undefined);
  stores.shared.getState().removeChannel(channelId);
  (stores.live ?? useBotLiveMessageStore).getState().clearChannel(channelId);
  stores.channels.getState().removeChannel(channelId);
  const runIds = Object.values(stores.operations.getState().runsById)
    .filter((run) => run.channelId === channelId)
    .map((run) => run.id);
  for (const runId of runIds) stores.operations.getState().removeRun(runId);
};

const applyEvent = (stores: BotEventStores, event: BotEventEnvelope): void => {
  const { payload } = event;
  const liveStore = stores.live ?? useBotLiveMessageStore;
  if (event.kind === 'computer.activity' && isComputerActivity(payload.activity)) {
    const activity = payload.activity;
    if (stores.channels.getState().channelsById[activity.channelId]?.botId === activity.botId) {
      useBotComputerActivityStore.getState().upsert(activity);
    }
    return;
  }
  if (event.kind === 'memory.changed') {
    const botId = event.botId || (typeof payload.botId === 'string' ? payload.botId : null);
    if (botId && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('devryan:bot-memory-changed', {
        detail: { botId },
      }));
    }
    return;
  }
  if (event.kind === 'bot.removed' || event.kind === 'bot.purged') {
    const botId = event.botId || (typeof payload.botId === 'string' ? payload.botId : null);
    if (botId) removeBotScopedState(stores, botId);
    return;
  }
  if (event.kind.startsWith('bot.')) {
    const previous = isRecord(payload.bot) && typeof payload.bot.id === 'string'
      ? stores.bots.getState().botsById[payload.bot.id]
      : undefined;
    const bot = parseBot(payload.bot, previous);
    if (bot) {
      stores.bots.getState().upsertBot(bot);
      if (bot.lifecycle !== 'active') stores.operations.getState().removeComputer(bot.id);
    }
    return;
  }
  if (event.kind.startsWith('revision.') && isRevision(payload.revision)) {
    stores.bots.getState().upsertRevision(payload.revision);
    return;
  }
  if (event.kind.startsWith('membership.') && isMembership(payload.membership)) {
    if (event.kind === 'membership.revoked' || payload.membership.revokedAt !== null) {
      removeBotScopedState(stores, payload.membership.botId);
    } else {
      stores.bots.getState().upsertMembership(payload.membership);
    }
    return;
  }
  if (event.kind === 'membership.revoked') {
    const botId = event.botId || (typeof payload.botId === 'string' ? payload.botId : null);
    if (botId) removeBotScopedState(stores, botId);
    return;
  }
  if (event.kind.startsWith('channel.') && isChannel(payload.channel)) {
    if (['channel.archived', 'channel.revoked', 'channel.removed'].includes(event.kind)) {
      removeChannelScopedState(stores, payload.channel.id);
    } else {
      stores.channels.getState().upsertChannel(payload.channel);
    }
    return;
  }
  if (['channel.archived', 'channel.revoked', 'channel.removed'].includes(event.kind)) {
    const channelId = event.channelId
      || (typeof payload.channelId === 'string' ? payload.channelId : null);
    if (channelId) removeChannelScopedState(stores, channelId);
    return;
  }
  if ((event.kind === 'message.created' || event.kind === 'message.updated')
    && isMessage(payload.message)) {
    stores.channels.getState().upsertMessage(payload.message);
    liveStore.getState().reconcileCanonical(
      payload.message.id,
      Number.isSafeInteger(payload.streamRevision) ? Number(payload.streamRevision) : null,
      payload.message.finalizedAt !== null,
    );
    if (payload.message.role === 'assistant' && payload.message.assistantPhase === 'result' && payload.message.finalizedAt !== null) {
      markFinalBotResponse(payload.message);
    }
    if (isChannelPreview(payload.channelPreview)) {
      stores.channels.getState().upsertPreview(payload.channelPreview);
    }
    const run = parseRun(payload.run);
    if (run) stores.operations.getState().upsertRun(run);
    return;
  }
  if (event.kind === 'message.streaming') {
    const message = parseStreamingMessage(payload);
    if (message) liveStore.getState().upsert(message);
    return;
  }
  const run = event.kind.startsWith('run.') ? parseRun(payload.run) : null;
  if (run) {
    stores.operations.getState().upsertRun(run);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
      liveStore.getState().clearRun(run.id);
      stores.channels.getState().pruneInactiveCache();
    }
    return;
  }
  if (event.kind.startsWith('action.') && isAction(payload.action)) {
    stores.operations.getState().upsertAction(payload.action);
    return;
  }
  if (event.kind === 'shared_file.updated' && isSharedFile(payload.sharedFile)) {
    const sharedFile = payload.sharedFile;
    const channel = stores.channels.getState().channelsById[sharedFile.channelId];
    if (channel?.botId === sharedFile.botId) stores.shared.getState().upsertFile(sharedFile);
    return;
  }
  if (event.kind === 'computer.status' && isComputer(payload.computer)) {
    stores.operations.getState().upsertComputer(payload.computer);
    return;
  }
  if (event.kind.startsWith('computer.control.') && typeof payload.botId === 'string') {
    if (payload.control === null || isComputerControl(payload.control)) {
      stores.operations.getState().updateComputerControl(
        payload.botId,
        payload.control,
      );
    }
  }
};

// eslint-disable-next-line react-refresh/only-export-components -- Pure reconciler is exported for deterministic SSE tests.
export const createBotEventReconciler = ({
  stores = {
    bots: useBotsStore,
    channels: useBotChannelStore,
    operations: useBotOperationsStore,
    shared: useBotSharedFilesStore,
  },
}: {
  stores?: BotEventStores;
} = {}) => {
  let cursor: BotEventCursor = { epoch: null, sequence: 0 };

  return Object.freeze({
    getCursor: (): BotEventCursor => cursor,

    reset() {
      cursor = { epoch: null, sequence: 0 };
    },

    ingest(value: unknown): BotEventIngestResult {
      const event = parseEnvelope(value);
      if (!event) return { accepted: false, reason: 'invalid' };
      const epoch = epochFromId(event.id);
      if (!epoch) return { accepted: false, reason: 'invalid' };
      if (event.kind === 'snapshot') {
        const snapshot = parseSnapshot(event.payload);
        if (!snapshot || event.sequence !== 0) return { accepted: false, reason: 'invalid' };
        const priorSequence = cursor.epoch === epoch ? cursor.sequence : 0;
        cursor = { epoch, sequence: priorSequence };
        stores.bots.getState().replaceSnapshot(snapshot);
        stores.channels.getState().replaceSnapshot(snapshot);
        stores.operations.getState().replaceSnapshot(snapshot);
        stores.shared.getState().replaceSnapshot(snapshot.channels);
        const activities = Array.isArray(event.payload.computerActivity) ? event.payload.computerActivity : [];
        useBotComputerActivityStore.getState().replace(activities.filter(isComputerActivity).filter((activity) =>
          snapshot.channels.some((channel) => channel.id === activity.channelId && channel.botId === activity.botId)));
        (stores.live ?? useBotLiveMessageStore).getState().reset();
        const activeBotIds = new Set(snapshot.bots
          .filter((bot) => bot.lifecycle === 'active')
          .map((bot) => bot.id));
        const readableChannelIds = new Set(snapshot.channels.map((channel) => channel.id));
        for (const view of Object.values(stores.operations.getState().computerViewsByBotId)) {
          if (activeBotIds.has(view.botId) && readableChannelIds.has(view.channelId)) continue;
          void stores.operations.getState().stopComputerView(view.botId).catch(() => undefined);
        }
        return { accepted: true, reason: 'snapshot' };
      }
      if (cursor.epoch !== epoch) return { accepted: false, reason: 'wrong_epoch' };
      if (event.sequence <= cursor.sequence) return { accepted: false, reason: 'stale' };
      cursor = { epoch, sequence: event.sequence };
      applyEvent(stores, event);
      return { accepted: true, reason: 'event' };
    },
  });
};

let ownerCount = 0;
let cleanupGeneration = 0;
const resetStores = (principalId: string | null): void => {
  useBotComputerActivityStore.getState().reset();
  useBotsStore.getState().resetPrincipal(principalId);
  useBotChannelStore.getState().resetPrincipal(principalId);
  useBotOperationsStore.getState().resetPrincipal(principalId);
  useBotSharedFilesStore.getState().resetPrincipal(principalId);
  useBotLiveMessageStore.getState().reset();
};

const controlPlaneCanStream = (state: string): boolean => ![
  'supabase_unavailable',
  'migration_required',
].includes(state);

const transientControlPlaneState = (state: string): boolean => [
  'supabase_unavailable',
  'migration_required',
].includes(state);

export const BotsEventOwner: React.FC = () => {
  const principal = useAuthPrincipal();
  const principalId = principal.id;
  const canUseBots = hasAuthCapability(principal, 'bots');

  React.useEffect(() => {
    ownerCount += 1;
    cleanupGeneration += 1;
    resetStores(principalId);
    const reconciler = createBotEventReconciler();
    let disposed = false;
    if (!canUseBots) {
      useBotsStore.getState().setCapabilities({
        available: false,
        state: 'unavailable',
        code: 'bots_access_disabled',
        owner: 'policy',
        canManageRuntime: false,
        canCreateBot: false,
        runtime: null,
      });
      useBotOperationsStore.getState().setConnectionState('unsupported', 'bots_access_disabled');
      return () => {
        disposed = true;
        ownerCount = Math.max(0, ownerCount - 1);
        const generation = ++cleanupGeneration;
        queueMicrotask(() => {
          if (ownerCount === 0 && cleanupGeneration === generation) resetStores(null);
        });
      };
    }
    if (isVSCodeRuntime()) {
      useBotsStore.getState().setCapabilities({
        available: false,
        state: 'unsupported_host',
        code: 'bots_vscode_unsupported',
        owner: 'vscode',
        canManageRuntime: false,
        canCreateBot: false,
        runtime: null,
      });
      useBotOperationsStore.getState().setConnectionState('unsupported');
      return () => {
        disposed = true;
        ownerCount = Math.max(0, ownerCount - 1);
        const generation = ++cleanupGeneration;
        queueMicrotask(() => {
          if (ownerCount === 0 && cleanupGeneration === generation) resetStores(null);
        });
      };
    }

    const controller = createBotCapabilityConnectionController({
      loadCapabilities: () => useBotsStore.getState().loadCapabilities(),
      getCapabilitiesErrorCode: () => useBotsStore.getState().capabilitiesErrorCode,
      canStream: controlPlaneCanStream,
      isTransient: transientControlPlaneState,
      setConnectionState: (state, errorCode) => {
        if (!disposed) useBotOperationsStore.getState().setConnectionState(state, errorCode);
      },
      createConnection: (initialRecoveryErrorCode) => createBotEventConnectionController({
        eventKinds: BOT_EVENT_KINDS,
        createSource: () => new EventSource(
          '/api/bots/events',
          { withCredentials: true },
        ) as BotEventSource,
        ingest: (value) => reconciler.ingest(value),
        setConnectionState: (state, errorCode) => {
          if (!disposed) useBotOperationsStore.getState().setConnectionState(state, errorCode);
        },
        initialRecoveryErrorCode,
        onReconnectedSnapshot: () => {
          const activeChannelId = useBotChannelStore.getState().activeChannelId;
          if (activeChannelId) {
            void useBotChannelStore.getState().refreshLatestMessages(activeChannelId)
            .catch(() => undefined);
          }
        },
      }),
    });

    installBotEventConnection(controller);
    controller.start();
    return () => {
      disposed = true;
      releaseBotEventConnection(controller);
      ownerCount = Math.max(0, ownerCount - 1);
      const generation = ++cleanupGeneration;
      queueMicrotask(() => {
        if (ownerCount === 0 && cleanupGeneration === generation) resetStores(null);
      });
    };
  }, [canUseBots, principalId]);

  return null;
};
