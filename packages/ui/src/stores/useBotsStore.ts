import { create, type StoreApi, type UseBoundStore } from 'zustand';

import {
  botsApi,
  BotsApiError,
  type BotCapabilities,
  type BotMembershipSummary,
  type BotRevisionSummary,
  type BotsApi,
  type BotSnapshot,
  type BotSummary,
} from '@/lib/botsApi';

type CatalogSnapshot = Pick<BotSnapshot, 'bots' | 'revisions' | 'memberships'>;

type BotsState = {
  principalId: string | null;
  capabilities: BotCapabilities | null;
  capabilitiesLoading: boolean;
  capabilitiesErrorCode: string | null;
  botsById: Readonly<Record<string, BotSummary>>;
  botIds: readonly string[];
  revisionsById: Readonly<Record<string, BotRevisionSummary>>;
  revisionIdsByBotId: Readonly<Record<string, readonly string[]>>;
  membershipsByBotId: Readonly<Record<string, BotMembershipSummary>>;
  selectedBotId: string | null;
  resetPrincipal(principalId: string | null): void;
  loadCapabilities(): Promise<BotCapabilities | null>;
  setCapabilities(capabilities: BotCapabilities | null, errorCode?: string | null): void;
  replaceSnapshot(snapshot: CatalogSnapshot): void;
  upsertBot(bot: BotSummary): void;
  removeBot(botId: string): void;
  upsertRevision(revision: BotRevisionSummary): void;
  upsertMembership(membership: BotMembershipSummary): void;
  removeMembership(botId: string): void;
  selectBot(botId: string | null): void;
};

export type BotsStore = UseBoundStore<StoreApi<BotsState>>;

const botEqual = (left: BotSummary, right: BotSummary): boolean => (
  left.id === right.id
  && left.name === right.name
  && left.title === right.title
  && left.summary === right.summary
  && left.avatarUrl === right.avatarUrl
  && left.avatarFallback === right.avatarFallback
  && left.lifecycle === right.lifecycle
  && left.tenancy === right.tenancy
  && left.activeRevisionId === right.activeRevisionId
  && left.createdAt === right.createdAt
  && left.updatedAt === right.updatedAt
  && left.retiredAt === right.retiredAt
);

const revisionEqual = (left: BotRevisionSummary, right: BotRevisionSummary): boolean => (
  left.id === right.id
  && left.botId === right.botId
  && left.revisionNumber === right.revisionNumber
  && left.compiledHash === right.compiledHash
  && left.createdAt === right.createdAt
  && left.activatedAt === right.activatedAt
  && left.retiredAt === right.retiredAt
);

const membershipEqual = (
  left: BotMembershipSummary,
  right: BotMembershipSummary,
): boolean => (
  left.botId === right.botId
  && left.userId === right.userId
  && left.role === right.role
  && left.activatedAt === right.activatedAt
  && left.revokedAt === right.revokedAt
  && left.updatedAt === right.updatedAt
);

const sameIds = (left: readonly string[], right: readonly string[]): boolean => (
  left === right
  || (left.length === right.length && left.every((id, index) => id === right[index]))
);

const sortedBotIds = (records: Readonly<Record<string, BotSummary>>): readonly string[] => (
  Object.values(records)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((bot) => bot.id)
);

const sortedRevisionIds = (
  records: Readonly<Record<string, BotRevisionSummary>>,
): Readonly<Record<string, readonly string[]>> => {
  const grouped: Record<string, BotRevisionSummary[]> = {};
  for (const revision of Object.values(records)) {
    (grouped[revision.botId] ||= []).push(revision);
  }
  return Object.fromEntries(Object.entries(grouped).map(([botId, revisions]) => [
    botId,
    revisions
      .sort((left, right) => left.revisionNumber - right.revisionNumber || left.id.localeCompare(right.id))
      .map((revision) => revision.id),
  ]));
};

const preserveRecord = <T>(current: T | undefined, next: T, equal: (a: T, b: T) => boolean): T => (
  current && equal(current, next) ? current : next
);

const omitKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => (
  Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
);

const reconcileRecords = <T extends { id: string }>(
  current: Readonly<Record<string, T>>,
  incoming: readonly T[],
  equal: (left: T, right: T) => boolean,
): Readonly<Record<string, T>> => {
  const next: Record<string, T> = {};
  let changed = Object.keys(current).length !== incoming.length;
  for (const record of incoming) {
    const preserved = preserveRecord(current[record.id], record, equal);
    next[record.id] = preserved;
    if (preserved !== current[record.id]) changed = true;
  }
  return changed ? next : current;
};

export const createBotsStore = ({ api = botsApi }: { api?: BotsApi } = {}): BotsStore => {
  let capabilityRequest = 0;
  return create<BotsState>((set, get) => ({
    principalId: null,
    capabilities: null,
    capabilitiesLoading: false,
    capabilitiesErrorCode: null,
    botsById: {},
    botIds: [],
    revisionsById: {},
    revisionIdsByBotId: {},
    membershipsByBotId: {},
    selectedBotId: null,

    resetPrincipal(principalId) {
      capabilityRequest += 1;
      set((state) => {
        if (
          state.principalId === principalId
          && state.capabilities === null
          && Object.keys(state.botsById).length === 0
          && Object.keys(state.revisionsById).length === 0
          && Object.keys(state.membershipsByBotId).length === 0
          && state.selectedBotId === null
        ) return state;
        return {
          principalId,
          capabilities: null,
          capabilitiesLoading: false,
          capabilitiesErrorCode: null,
          botsById: {},
          botIds: [],
          revisionsById: {},
          revisionIdsByBotId: {},
          membershipsByBotId: {},
          selectedBotId: null,
        };
      });
    },

    async loadCapabilities() {
      const request = ++capabilityRequest;
      set((state) => state.capabilitiesLoading
        ? state
        : { capabilitiesLoading: true, capabilitiesErrorCode: null });
      try {
        const capabilities = await api.getCapabilities();
        if (request !== capabilityRequest) return null;
        set((state) => (
          state.capabilities === capabilities
          && !state.capabilitiesLoading
          && state.capabilitiesErrorCode === null
            ? state
            : { capabilities, capabilitiesLoading: false, capabilitiesErrorCode: null }
        ));
        return capabilities;
      } catch (error) {
        if (request !== capabilityRequest) return null;
        const errorCode = error instanceof BotsApiError ? error.code : 'bot_request_failed';
        set({ capabilities: null, capabilitiesLoading: false, capabilitiesErrorCode: errorCode });
        return null;
      }
    },

    setCapabilities(capabilities, errorCode = null) {
      capabilityRequest += 1;
      set((state) => (
        state.capabilities === capabilities
        && !state.capabilitiesLoading
        && state.capabilitiesErrorCode === errorCode
          ? state
          : { capabilities, capabilitiesLoading: false, capabilitiesErrorCode: errorCode }
      ));
    },

    replaceSnapshot(snapshot) {
      set((state) => {
        const botsById = reconcileRecords(state.botsById, snapshot.bots, botEqual);
        const revisionsById = reconcileRecords(
          state.revisionsById,
          snapshot.revisions,
          revisionEqual,
        );
        const memberships = Object.fromEntries(snapshot.memberships.map((membership) => [
          membership.botId,
          preserveRecord(
            state.membershipsByBotId[membership.botId],
            membership,
            membershipEqual,
          ),
        ]));
        const membershipsByBotId = (
          Object.keys(memberships).length === Object.keys(state.membershipsByBotId).length
          && Object.entries(memberships).every(([botId, membership]) => (
            membership === state.membershipsByBotId[botId]
          ))
        ) ? state.membershipsByBotId : memberships;
        const computedBotIds = sortedBotIds(botsById);
        const botIds = sameIds(state.botIds, computedBotIds) ? state.botIds : computedBotIds;
        const computedRevisionIds = sortedRevisionIds(revisionsById);
        const revisionGroupsUnchanged = (
          Object.keys(computedRevisionIds).length === Object.keys(state.revisionIdsByBotId).length
          && Object.entries(computedRevisionIds).every(([botId, ids]) => (
            sameIds(state.revisionIdsByBotId[botId] || [], ids)
          ))
        );
        const revisionIdsByBotId = revisionGroupsUnchanged
          ? state.revisionIdsByBotId
          : Object.fromEntries(Object.entries(computedRevisionIds).map(([botId, ids]) => [
              botId,
              sameIds(state.revisionIdsByBotId[botId] || [], ids)
                ? state.revisionIdsByBotId[botId]
                : ids,
            ]));
        const selectedBotId = state.selectedBotId && botsById[state.selectedBotId]
          ? state.selectedBotId
          : null;
        if (
          botsById === state.botsById
          && botIds === state.botIds
          && revisionsById === state.revisionsById
          && revisionIdsByBotId === state.revisionIdsByBotId
          && membershipsByBotId === state.membershipsByBotId
          && selectedBotId === state.selectedBotId
        ) return state;
        return {
          botsById,
          botIds,
          revisionsById,
          revisionIdsByBotId,
          membershipsByBotId,
          selectedBotId,
        };
      });
    },

    upsertBot(bot) {
      set((state) => {
        const preserved = preserveRecord(state.botsById[bot.id], bot, botEqual);
        if (preserved === state.botsById[bot.id]) return state;
        const botsById = { ...state.botsById, [bot.id]: preserved };
        const computed = sortedBotIds(botsById);
        return {
          botsById,
          botIds: sameIds(state.botIds, computed) ? state.botIds : computed,
        };
      });
    },

    removeBot(botId) {
      set((state) => {
        if (!state.botsById[botId]) return state;
        const botsById = omitKey(state.botsById, botId);
        const revisionIds = state.revisionIdsByBotId[botId] || [];
        const revisionsById = { ...state.revisionsById };
        for (const revisionId of revisionIds) delete revisionsById[revisionId];
        const revisionIdsByBotId = omitKey(state.revisionIdsByBotId, botId);
        const membershipsByBotId = omitKey(state.membershipsByBotId, botId);
        return {
          botsById,
          botIds: state.botIds.filter((id) => id !== botId),
          revisionsById,
          revisionIdsByBotId,
          membershipsByBotId,
          selectedBotId: state.selectedBotId === botId ? null : state.selectedBotId,
        };
      });
    },

    upsertRevision(revision) {
      set((state) => {
        const current = state.revisionsById[revision.id];
        const preserved = preserveRecord(current, revision, revisionEqual);
        if (preserved === current) return state;
        const revisionsById = { ...state.revisionsById, [revision.id]: preserved };
        const currentIds = state.revisionIdsByBotId[revision.botId] || [];
        const ids = currentIds.includes(revision.id) ? currentIds : [...currentIds, revision.id];
        const sorted = [...ids].sort((leftId, rightId) => (
          revisionsById[leftId].revisionNumber - revisionsById[rightId].revisionNumber
          || leftId.localeCompare(rightId)
        ));
        return {
          revisionsById,
          revisionIdsByBotId: {
            ...state.revisionIdsByBotId,
            [revision.botId]: sameIds(currentIds, sorted) ? currentIds : sorted,
          },
        };
      });
    },

    upsertMembership(membership) {
      set((state) => {
        const current = state.membershipsByBotId[membership.botId];
        const preserved = preserveRecord(current, membership, membershipEqual);
        if (preserved === current) return state;
        return { membershipsByBotId: { ...state.membershipsByBotId, [membership.botId]: preserved } };
      });
    },

    removeMembership(botId) {
      set((state) => {
        if (!state.membershipsByBotId[botId]) return state;
        const membershipsByBotId = omitKey(state.membershipsByBotId, botId);
        return { membershipsByBotId };
      });
    },

    selectBot(botId) {
      const normalized = botId && get().botsById[botId] ? botId : null;
      set((state) => state.selectedBotId === normalized ? state : { selectedBotId: normalized });
    },
  }));
};

export const useBotsStore = createBotsStore();

export const botsSelectors = Object.freeze({
  bot: (botId: string) => (state: BotsState) => state.botsById[botId],
  membership: (botId: string) => (state: BotsState) => state.membershipsByBotId[botId],
  revisionIds: (botId: string) => (state: BotsState) => (
    state.revisionIdsByBotId[botId] || []
  ),
});
