import { create, type StoreApi, type UseBoundStore } from 'zustand';

import {
  botsApi,
  BotsApiError,
  type BotActionAttempt,
  type BotApprovalDecisionRequest,
  type BotComputerControl,
  type BotComputerStatus,
  type BotComputerViewSession,
  type BotHumanInputEvent,
  type BotReconciliationRequest,
  type BotRun,
  type BotsApi,
  type BotSnapshot,
} from '@/lib/botsApi';

export type BotEventsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unsupported'
  | 'error';

type OperationsSnapshot = Pick<BotSnapshot, 'runs' | 'recentActions' | 'pendingApprovals' | 'computers'>;

export type BotOperationsState = {
  principalId: string | null;
  runsById: Readonly<Record<string, BotRun>>;
  runIdsByChannelId: Readonly<Record<string, readonly string[]>>;
  actionsById: Readonly<Record<string, BotActionAttempt>>;
  actionIdsByRunId: Readonly<Record<string, readonly string[]>>;
  pendingApprovalIds: readonly string[];
  computersByBotId: Readonly<Record<string, BotComputerStatus>>;
  computerViewsByBotId: Readonly<Record<string, BotComputerViewSession>>;
  computerViewPendingByBotId: Readonly<Record<string, true>>;
  computerViewErrorCodeByBotId: Readonly<Record<string, string>>;
  decisionPendingByActionId: Readonly<Record<string, true>>;
  actionErrorCodeById: Readonly<Record<string, string>>;
  connectionState: BotEventsConnectionState;
  connectionErrorCode: string | null;
  resetPrincipal(principalId: string | null): void;
  replaceSnapshot(snapshot: OperationsSnapshot): void;
  upsertRun(run: BotRun): void;
  removeRun(runId: string): void;
  upsertAction(action: BotActionAttempt): void;
  removeAction(actionId: string): void;
  upsertComputer(status: BotComputerStatus): void;
  updateComputerControl(botId: string, control: BotComputerControl | null): void;
  removeComputer(botId: string): void;
  setConnectionState(state: BotEventsConnectionState, errorCode?: string | null): void;
  cancelRun(runId: string): Promise<BotRun>;
  decideAction(actionId: string, request: BotApprovalDecisionRequest): Promise<BotActionAttempt>;
  reconcileAction(actionId: string, request: BotReconciliationRequest): Promise<BotActionAttempt>;
  refreshComputer(botId: string, expectedLeaseId?: string): Promise<BotComputerStatus>;
  refreshComputerDiagnostic(botId: string): Promise<BotComputerStatus>;
  startComputerView(botId: string, channelId: string, runId?: string): Promise<BotComputerViewSession>;
  stopComputerView(botId: string): Promise<boolean>;
  takeComputerControl(botId: string): Promise<BotComputerControl | null>;
  heartbeatComputerControl(botId: string, leaseId: string): Promise<BotComputerControl | null>;
  returnComputerControl(botId: string, leaseId: string): Promise<BotComputerControl | null>;
  sendHumanComputerInput(
    botId: string,
    viewId: string,
    leaseId: string,
    events: readonly BotHumanInputEvent[],
    signal?: AbortSignal,
  ): Promise<void>;
};

export type BotOperationsStore = UseBoundStore<StoreApi<BotOperationsState>>;

const sameSerializable = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const preserve = <T>(current: T | undefined, next: T): T => (
  current !== undefined && sameSerializable(current, next) ? current : next
);

const TERMINAL_RUN_STATES = new Set<BotRun['state']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const preserveRun = (current: BotRun | undefined, next: BotRun): BotRun => {
  if (!current) return next;
  const currentUpdatedAt = current.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
  const nextUpdatedAt = next.updatedAt ? Date.parse(next.updatedAt) : Number.NaN;
  if (Number.isFinite(currentUpdatedAt) && !Number.isFinite(nextUpdatedAt)) return current;
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(nextUpdatedAt)
    && nextUpdatedAt < currentUpdatedAt) return current;
  if (TERMINAL_RUN_STATES.has(current.state) && current.state !== next.state
    && (!Number.isFinite(currentUpdatedAt) || !Number.isFinite(nextUpdatedAt)
      || nextUpdatedAt <= currentUpdatedAt)) return current;
  return preserve(current, next);
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean => (
  left === right
  || (left.length === right.length && left.every((id, index) => id === right[index]))
);

const omitKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => (
  Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
);

const reconcileRecords = <T extends { id: string }>(
  current: Readonly<Record<string, T>>,
  incoming: readonly T[],
): Readonly<Record<string, T>> => {
  const next: Record<string, T> = {};
  let changed = Object.keys(current).length !== incoming.length;
  for (const record of incoming) {
    const value = preserve(current[record.id], record);
    next[record.id] = value;
    if (value !== current[record.id]) changed = true;
  }
  return changed ? next : current;
};

const groupedRunIds = (
  runsById: Readonly<Record<string, BotRun>>,
  previous: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> => {
  const groups: Record<string, BotRun[]> = {};
  for (const run of Object.values(runsById)) (groups[run.channelId] ||= []).push(run);
  const computed = Object.fromEntries(Object.entries(groups).map(([channelId, runs]) => [
    channelId,
    runs
      .sort((left, right) => (
        (left.queueSequence ?? Number.MAX_SAFE_INTEGER)
        - (right.queueSequence ?? Number.MAX_SAFE_INTEGER)
        || (left.createdAt || '').localeCompare(right.createdAt || '')
        || left.id.localeCompare(right.id)
      ))
      .map((run) => run.id),
  ]));
  if (
    Object.keys(computed).length === Object.keys(previous).length
    && Object.entries(computed).every(([channelId, ids]) => sameIds(previous[channelId] || [], ids))
  ) return previous;
  return Object.fromEntries(Object.entries(computed).map(([channelId, ids]) => [
    channelId,
    sameIds(previous[channelId] || [], ids) ? previous[channelId] : ids,
  ]));
};

const pendingIds = (
  actionsById: Readonly<Record<string, BotActionAttempt>>,
  previous: readonly string[],
): readonly string[] => {
  const next = Object.values(actionsById)
    .filter((action) => action.state === 'pending_approval')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((action) => action.id);
  return sameIds(previous, next) ? previous : next;
};

const errorCode = (error: unknown): string => (
  error instanceof BotsApiError ? error.code : 'bot_request_failed'
);

const browserDiagnosticFingerprint = (status: BotComputerStatus | undefined): string => {
  const browser = status?.browser;
  return JSON.stringify({
    running: browser?.running,
    healthy: browser?.healthy,
    launching: browser?.launching,
    lifecycleState: browser?.lifecycleState,
    generation: browser?.generation,
    lastFailureCode: browser?.lastFailureCode,
    mode: browser?.mode,
    engineVersion: browser?.engineVersion,
    displayReady: browser?.displayReady,
    activeTargetCount: browser?.activeTargetCount,
    popupOpen: browser?.popupOpen,
    webCapabilities: browser?.webCapabilities,
    diagnosticRevision: browser?.lastNavigationDiagnostic?.revision,
  });
};

const groupedActionIds = (
  actionsById: Readonly<Record<string, BotActionAttempt>>,
  previous: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> => {
  const groups: Record<string, BotActionAttempt[]> = {};
  for (const action of Object.values(actionsById)) (groups[action.runId] ||= []).push(action);
  const computed = Object.fromEntries(Object.entries(groups).map(([runId, actions]) => [
    runId,
    actions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((action) => action.id),
  ]));
  if (Object.keys(computed).length === Object.keys(previous).length
    && Object.entries(computed).every(([runId, ids]) => sameIds(previous[runId] || [], ids))) {
    return previous;
  }
  return Object.fromEntries(Object.entries(computed).map(([runId, ids]) => [
    runId,
    sameIds(previous[runId] || [], ids) ? previous[runId] : ids,
  ]));
};

export const createBotOperationsStore = (
  { api = botsApi }: { api?: BotsApi } = {},
): BotOperationsStore => {
  let principalGeneration = 0;
  const computerViewStarts = new Map<string, Promise<BotComputerViewSession>>();
  const computerViewGenerations = new Map<string, number>();
  return create<BotOperationsState>((set, get) => ({
  principalId: null,
  runsById: {},
  runIdsByChannelId: {},
  actionsById: {},
  actionIdsByRunId: {},
  pendingApprovalIds: [],
  computersByBotId: {},
  computerViewsByBotId: {},
  computerViewPendingByBotId: {},
  computerViewErrorCodeByBotId: {},
  decisionPendingByActionId: {},
  actionErrorCodeById: {},
  connectionState: 'idle',
  connectionErrorCode: null,

  resetPrincipal(principalId) {
    principalGeneration += 1;
    computerViewGenerations.clear();
    for (const view of Object.values(get().computerViewsByBotId)) {
      void api.stopComputerView(view.botId, view.id).catch(() => undefined);
    }
    set((state) => {
      if (
        state.principalId === principalId
        && Object.keys(state.runsById).length === 0
        && Object.keys(state.actionsById).length === 0
        && Object.keys(state.computersByBotId).length === 0
        && Object.keys(state.computerViewsByBotId).length === 0
        && Object.keys(state.computerViewPendingByBotId).length === 0
        && Object.keys(state.computerViewErrorCodeByBotId).length === 0
        && state.connectionState === 'idle'
        && state.connectionErrorCode === null
      ) return state;
      return {
        principalId,
        runsById: {},
        runIdsByChannelId: {},
        actionsById: {},
        actionIdsByRunId: {},
        pendingApprovalIds: [],
        computersByBotId: {},
        computerViewsByBotId: {},
        computerViewPendingByBotId: {},
        computerViewErrorCodeByBotId: {},
        decisionPendingByActionId: {},
        actionErrorCodeById: {},
        connectionState: 'idle',
        connectionErrorCode: null,
      };
    });
  },

  replaceSnapshot(snapshot) {
    set((state) => {
      const runsById = reconcileRecords(state.runsById, snapshot.runs);
      const snapshotActions = [...(snapshot.recentActions ?? []), ...snapshot.pendingApprovals]
        .filter((action, index, values) => values.findIndex((item) => item.id === action.id) === index);
      const actionsById = reconcileRecords(state.actionsById, snapshotActions);
      const actionIdsByRunId = groupedActionIds(actionsById, state.actionIdsByRunId);
      const computerRecords = Object.fromEntries(snapshot.computers.map((computer) => [
        computer.botId,
        preserve(state.computersByBotId[computer.botId], computer),
      ]));
      const computersByBotId = (
        Object.keys(computerRecords).length === Object.keys(state.computersByBotId).length
        && Object.entries(computerRecords).every(([botId, computer]) => (
          computer === state.computersByBotId[botId]
        ))
      ) ? state.computersByBotId : computerRecords;
      const runIdsByChannelId = groupedRunIds(runsById, state.runIdsByChannelId);
      const nextPendingIds = pendingIds(actionsById, state.pendingApprovalIds);
      if (
        runsById === state.runsById
        && runIdsByChannelId === state.runIdsByChannelId
        && actionsById === state.actionsById
        && actionIdsByRunId === state.actionIdsByRunId
        && nextPendingIds === state.pendingApprovalIds
        && computersByBotId === state.computersByBotId
      ) return state;
      return {
        runsById,
        runIdsByChannelId,
        actionsById,
        actionIdsByRunId,
        pendingApprovalIds: nextPendingIds,
        computersByBotId,
      };
    });
  },

  upsertRun(run) {
    set((state) => {
      const current = state.runsById[run.id];
      const value = preserveRun(current, run);
      if (value === current) return state;
      const runsById = { ...state.runsById, [run.id]: value };
      return {
        runsById,
        runIdsByChannelId: groupedRunIds(runsById, state.runIdsByChannelId),
      };
    });
  },

  removeRun(runId) {
    set((state) => {
      if (!state.runsById[runId]) return state;
      const runsById = omitKey(state.runsById, runId);
      return {
        runsById,
        runIdsByChannelId: groupedRunIds(runsById, state.runIdsByChannelId),
      };
    });
  },

  upsertAction(action) {
    set((state) => {
      const current = state.actionsById[action.id];
      const value = preserve(current, action);
      if (value === current) return state;
      const actionsById = { ...state.actionsById, [action.id]: value };
      return {
        actionsById,
        actionIdsByRunId: groupedActionIds(actionsById, state.actionIdsByRunId),
        pendingApprovalIds: pendingIds(actionsById, state.pendingApprovalIds),
      };
    });
  },

  removeAction(actionId) {
    set((state) => {
      if (!state.actionsById[actionId]) return state;
      const actionsById = omitKey(state.actionsById, actionId);
      return {
        actionsById,
        actionIdsByRunId: groupedActionIds(actionsById, state.actionIdsByRunId),
        pendingApprovalIds: pendingIds(actionsById, state.pendingApprovalIds),
      };
    });
  },

  upsertComputer(status) {
    set((state) => {
      const current = state.computersByBotId[status.botId];
      const value = preserve(current, status);
      if (value === current) return state;
      return { computersByBotId: { ...state.computersByBotId, [status.botId]: value } };
    });
  },

  updateComputerControl(botId, control) {
    set((state) => {
      const current = state.computersByBotId[botId];
      if (!current || sameSerializable(current.control, control)) return state;
      return {
        computersByBotId: {
          ...state.computersByBotId,
          [botId]: { ...current, control },
        },
      };
    });
  },

  removeComputer(botId) {
    const view = get().computerViewsByBotId[botId];
    if (view) void api.stopComputerView(botId, view.id).catch(() => undefined);
    set((state) => {
      if (!state.computersByBotId[botId]
        && !state.computerViewsByBotId[botId]
        && !state.computerViewPendingByBotId[botId]
        && !state.computerViewErrorCodeByBotId[botId]) return state;
      return {
        computersByBotId: omitKey(state.computersByBotId, botId),
        computerViewsByBotId: omitKey(state.computerViewsByBotId, botId),
        computerViewPendingByBotId: omitKey(state.computerViewPendingByBotId, botId),
        computerViewErrorCodeByBotId: omitKey(state.computerViewErrorCodeByBotId, botId),
      };
    });
  },

  setConnectionState(connectionState, connectionErrorCode = null) {
    set((state) => (
      state.connectionState === connectionState
      && state.connectionErrorCode === connectionErrorCode
        ? state
        : { connectionState, connectionErrorCode }
    ));
  },

  async cancelRun(runId) {
    const generation = principalGeneration;
    const { run } = await api.cancelRun(runId);
    if (generation === principalGeneration) get().upsertRun(run);
    return run;
  },

  async decideAction(actionId, request) {
    const generation = principalGeneration;
    set((state) => ({
      decisionPendingByActionId: { ...state.decisionPendingByActionId, [actionId]: true },
      actionErrorCodeById: Object.fromEntries(
        Object.entries(state.actionErrorCodeById).filter(([id]) => id !== actionId),
      ),
    }));
    try {
      const { action } = await api.decideAction(actionId, request);
      if (generation === principalGeneration) get().upsertAction(action);
      return action;
    } catch (error) {
      if (generation !== principalGeneration) throw error;
      set((state) => ({
        actionErrorCodeById: { ...state.actionErrorCodeById, [actionId]: errorCode(error) },
      }));
      throw error;
    } finally {
      if (generation === principalGeneration) {
        set((state) => {
          if (!state.decisionPendingByActionId[actionId]) return state;
          const decisionPendingByActionId = omitKey(state.decisionPendingByActionId, actionId);
          return { decisionPendingByActionId };
        });
      }
    }
  },

  async reconcileAction(actionId, request) {
    const generation = principalGeneration;
    const { action } = await api.reconcileAction(actionId, request);
    if (generation === principalGeneration) get().upsertAction(action);
    return action;
  },

  async refreshComputer(botId, expectedLeaseId) {
    const generation = principalGeneration;
    const expectedControl = get().computersByBotId[botId]?.control;
    const status = await api.getComputerStatus(botId);
    if (generation === principalGeneration && (expectedLeaseId === undefined
      || (expectedControl?.leaseId === expectedLeaseId && get().computersByBotId[botId]?.control === expectedControl))) {
      get().upsertComputer(status);
    }
    return status;
  },

  async refreshComputerDiagnostic(botId) {
    const generation = principalGeneration;
    const status = await api.getComputerStatus(botId);
    if (generation !== principalGeneration) return status;
    set((state) => {
      const current = state.computersByBotId[botId];
      if (browserDiagnosticFingerprint(current) === browserDiagnosticFingerprint(status)) return state;
      return {
        computersByBotId: {
          ...state.computersByBotId,
          [botId]: status,
        },
      };
    });
    return status;
  },

  async startComputerView(botId, channelId, runId) {
    const existing = get().computerViewsByBotId[botId];
    if (existing?.channelId === channelId && existing.runId === runId) return existing;
    if (existing) await get().stopComputerView(botId);
    const startKey = `${botId}:${channelId}:${runId ?? 'manual'}`;
    const inFlight = computerViewStarts.get(startKey);
    if (inFlight) return inFlight;
    const viewGeneration = (computerViewGenerations.get(botId) ?? 0) + 1;
    computerViewGenerations.set(botId, viewGeneration);
    const operation = (async () => {
      const generation = principalGeneration;
      set((state) => ({
        computerViewPendingByBotId: {
          ...state.computerViewPendingByBotId,
          [botId]: true,
        },
        computerViewErrorCodeByBotId: omitKey(state.computerViewErrorCodeByBotId, botId),
      }));
      try {
        const { view } = await api.startComputerView(botId, channelId, runId);
        if (generation === principalGeneration && computerViewGenerations.get(botId) === viewGeneration) {
          set((state) => ({
            computerViewsByBotId: { ...state.computerViewsByBotId, [botId]: view },
          }));
        } else {
          void api.stopComputerView(botId, view.id).catch(() => undefined);
        }
        return view;
      } catch (error) {
        if (generation === principalGeneration && computerViewGenerations.get(botId) === viewGeneration) {
          set((state) => ({
            computerViewErrorCodeByBotId: {
              ...state.computerViewErrorCodeByBotId,
              [botId]: errorCode(error),
            },
          }));
        }
        throw error;
      } finally {
        if (generation === principalGeneration && computerViewGenerations.get(botId) === viewGeneration) {
          set((state) => ({
            computerViewPendingByBotId: omitKey(state.computerViewPendingByBotId, botId),
          }));
        }
      }
    })();
    computerViewStarts.set(startKey, operation);
    try {
      return await operation;
    } finally {
      if (computerViewStarts.get(startKey) === operation) computerViewStarts.delete(startKey);
    }
  },

  async stopComputerView(botId) {
    const viewGeneration = (computerViewGenerations.get(botId) ?? 0) + 1;
    computerViewGenerations.set(botId, viewGeneration);
    for (const key of computerViewStarts.keys()) {
      if (key.startsWith(`${botId}:`)) computerViewStarts.delete(key);
    }
    const view = get().computerViewsByBotId[botId];
    const generation = principalGeneration;
    set((state) => ({
      computerViewsByBotId: omitKey(state.computerViewsByBotId, botId),
      computerViewPendingByBotId: omitKey(state.computerViewPendingByBotId, botId),
      computerViewErrorCodeByBotId: omitKey(state.computerViewErrorCodeByBotId, botId),
    }));
    if (!view) return false;
    try {
      const { stopped } = await api.stopComputerView(botId, view.id);
      return stopped;
    } catch (error) {
      if (generation === principalGeneration && computerViewGenerations.get(botId) === viewGeneration) {
        set((state) => ({
          computerViewErrorCodeByBotId: {
            ...state.computerViewErrorCodeByBotId,
            [botId]: errorCode(error),
          },
        }));
      }
      throw error;
    }
  },

  async takeComputerControl(botId) {
    const generation = principalGeneration;
    const { control } = await api.takeComputerControl(botId);
    if (generation === principalGeneration) get().updateComputerControl(botId, control);
    return control;
  },

  async heartbeatComputerControl(botId, leaseId) {
    const generation = principalGeneration;
    const { control } = await api.heartbeatComputerControl(botId, leaseId);
    if (generation === principalGeneration) get().updateComputerControl(botId, control);
    return control;
  },

  async returnComputerControl(botId, leaseId) {
    const generation = principalGeneration;
    const { control } = await api.returnComputerControl(botId, leaseId);
    if (generation === principalGeneration && get().computersByBotId[botId]?.control?.leaseId === leaseId) {
      get().updateComputerControl(botId, control);
    }
    return control;
  },

  async sendHumanComputerInput(botId, viewId, leaseId, events, signal) {
    await api.sendHumanComputerCommand(botId, {
      viewId,
      leaseId,
      command: 'input',
      args: { events },
    }, signal);
  },
  }));
};

export const useBotOperationsStore = createBotOperationsStore();

export const botOperationsSelectors = Object.freeze({
  run: (runId: string) => (state: BotOperationsState) => state.runsById[runId],
  runIds: (channelId: string) => (state: BotOperationsState) => (
    state.runIdsByChannelId[channelId] || []
  ),
  computer: (botId: string) => (state: BotOperationsState) => state.computersByBotId[botId],
  computerView: (botId: string) => (state: BotOperationsState) => state.computerViewsByBotId[botId],
  action: (actionId: string) => (state: BotOperationsState) => state.actionsById[actionId],
  actionIds: (runId: string) => (state: BotOperationsState) => state.actionIdsByRunId[runId] || [],
});
