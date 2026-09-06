/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { devtools } from './utils/devtoolsGate';
import type { EditPermissionMode, SessionContextUsage } from "./types/sessionTypes";
import { getAgentDefaultEditPermission } from "./utils/permissionUtils";
import { getContextUsageFromMessages, isSameSessionContextUsage } from "./utils/contextUsageUtils";
import { extractTokenBreakdownFromMessage } from "./utils/tokenUtils";
import { getSafeStorage } from "./utils/safeStorage";
import {
    UNAVAILABLE_MODEL_CONTEXT_CAPACITY,
    type ResolvedModelContextCapacity,
} from "./utils/modelContextCapacity";

type ContextUsage = SessionContextUsage;

interface ContextState {

    sessionModelSelections: Map<string, { providerId: string; modelId: string }>;
    sessionAgentSelections: Map<string, string>;

    sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>;

    // sessionId → agentName → "providerId/modelId" → variant
    sessionAgentModelVariantSelections: Map<string, Map<string, Map<string, string | null>>>;
 
    currentAgentContext: Map<string, string>;

    sessionContextUsage: Map<string, ContextUsage>;

    sessionAgentEditModes: Map<string, Map<string, EditPermissionMode>>;
    hasHydrated: boolean;
}

interface ContextActions {

    clearSessionContext: (sessionId: string) => void;

    saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
    getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null;
    saveSessionAgentSelection: (sessionId: string, agentName: string) => void;
    getSessionAgentSelection: (sessionId: string) => string | null;

    saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void;
    getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null;

    saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => void;
    getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | null | undefined;


    getContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity, messages: Map<string, { info: any; parts: any[] }[]>) => ContextUsage | null;

    updateSessionContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity, messages: Map<string, { info: any; parts: any[] }[]>) => void;

    initializeSessionContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity, messages: Map<string, { info: any; parts: any[] }[]>) => void;

    pollForTokenUpdates: (sessionId: string, messageId: string, messages: Map<string, { info: any; parts: any[] }[]>, maxAttempts?: number) => void;

    getCurrentAgent: (sessionId: string) => string | undefined;

    getSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => EditPermissionMode;
    toggleSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => void;
    setSessionAgentEditMode: (sessionId: string, agentName: string | undefined, mode: EditPermissionMode, defaultMode?: EditPermissionMode) => void;
}

type ContextStore = ContextState & ContextActions;

const EDIT_PERMISSION_SEQUENCE: EditPermissionMode[] = ['ask', 'allow', 'full'];
const GLOBAL_EDIT_MODE_SESSION_ID = '__global__';
const CONTEXT_STORE_VERSION = 2;

export const migratePersistedContextUsage = (value: unknown): ContextUsage | null => {
    if (!value || typeof value !== "object") return null;
    const legacy = value as Partial<ContextUsage> & {
        totalTokens?: unknown;
        relatedSubagentTotalTokens?: unknown;
        relatedSubagentSessions?: Array<Partial<NonNullable<ContextUsage["relatedSubagentSessions"]>[number]> & { totalTokens?: unknown }>;
    };
    const breakdown = legacy.tokenBreakdown;
    const detailedActive = breakdown
        ? Math.max(0, breakdown.input) + Math.max(0, breakdown.cacheRead) + Math.max(0, breakdown.cacheWrite)
        : 0;
    const legacyTotal = typeof legacy.totalTokens === "number" && Number.isFinite(legacy.totalTokens)
        ? Math.max(0, legacy.totalTokens)
        : 0;
    const activeInputTokens = typeof legacy.activeInputTokens === "number" && Number.isFinite(legacy.activeInputTokens)
        ? Math.max(0, legacy.activeInputTokens)
        : detailedActive > 0 ? detailedActive : legacyTotal;
    const percentage = typeof legacy.capacityLimit === "number" && legacy.capacityLimit > 0
        ? (activeInputTokens / legacy.capacityLimit) * 100
        : legacy.percentage ?? null;
    const legacyRelatedSessions = legacy.relatedSubagentSessions as Array<{
        activeInputTokens?: unknown;
        totalTokens?: unknown;
    }> | undefined;
    const relatedSubagentSessions = legacyRelatedSessions?.map((session) => {
        const normalized = { ...session };
        delete normalized.totalTokens;
        return {
            ...normalized,
            activeInputTokens: typeof session.activeInputTokens === "number"
                ? session.activeInputTokens
                : typeof session.totalTokens === "number" ? session.totalTokens : 0,
        };
    }) as ContextUsage["relatedSubagentSessions"];
    const normalizedLegacy = { ...legacy };
    delete normalizedLegacy.totalTokens;
    delete normalizedLegacy.relatedSubagentTotalTokens;

    return {
        ...(normalizedLegacy as ContextUsage),
        activeInputTokens,
        percentage,
        lastOutputTokens: typeof legacy.lastOutputTokens === "number"
            ? legacy.lastOutputTokens
            : breakdown?.output ?? 0,
        source: legacy.source === "meridian" ? "meridian" : "message-fallback",
        updatedAt: typeof legacy.updatedAt === "number" ? legacy.updatedAt : 0,
        tokenBreakdown: breakdown
            ? { ...breakdown, total: activeInputTokens }
            : {
                input: activeInputTokens,
                output: 0,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: activeInputTokens,
            },
        ...(relatedSubagentSessions ? { relatedSubagentSessions } : {}),
        relatedSubagentActiveInputTokens: typeof legacy.relatedSubagentActiveInputTokens === "number"
            ? legacy.relatedSubagentActiveInputTokens
            : typeof legacy.relatedSubagentTotalTokens === "number"
                ? legacy.relatedSubagentTotalTokens
                : relatedSubagentSessions?.reduce((sum, session) => sum + session.activeInputTokens, 0),
    };
};

type DeferredContextWork = {
    cancelled: boolean;
    timers: Set<ReturnType<typeof setTimeout>>;
};

const deferredContextWorkBySession = new Map<string, Set<DeferredContextWork>>();

const registerDeferredContextWork = (sessionId: string): DeferredContextWork => {
    const work: DeferredContextWork = {
        cancelled: false,
        timers: new Set(),
    };
    const sessionWork = deferredContextWorkBySession.get(sessionId) ?? new Set();
    sessionWork.add(work);
    deferredContextWorkBySession.set(sessionId, sessionWork);
    return work;
};

const releaseDeferredContextWork = (sessionId: string, work: DeferredContextWork) => {
    const sessionWork = deferredContextWorkBySession.get(sessionId);
    if (!sessionWork) return;

    sessionWork.delete(work);
    if (sessionWork.size === 0) {
        deferredContextWorkBySession.delete(sessionId);
    }
};

const scheduleDeferredContextTimer = (
    work: DeferredContextWork,
    callback: () => void,
    delay: number,
) => {
    if (work.cancelled) return;

    const timer = setTimeout(() => {
        work.timers.delete(timer);
        if (!work.cancelled) {
            callback();
        }
    }, delay);
    work.timers.add(timer);
};

const cancelDeferredContextWork = (sessionId: string) => {
    const sessionWork = deferredContextWorkBySession.get(sessionId);
    if (!sessionWork) return;

    for (const work of sessionWork) {
        work.cancelled = true;
        for (const timer of work.timers) {
            clearTimeout(timer);
        }
        work.timers.clear();
    }
    deferredContextWorkBySession.delete(sessionId);
};

const withoutSession = <Value>(source: Map<string, Value>, sessionId: string): Map<string, Value> => {
    if (!source.has(sessionId)) return source;

    const next = new Map(source);
    next.delete(sessionId);
    return next;
};

export const useContextStore = create<ContextStore>()(
    devtools(
        persist(
            (set, get) => ({

                sessionModelSelections: new Map(),
                sessionAgentSelections: new Map(),
                sessionAgentModelSelections: new Map(),
                sessionAgentModelVariantSelections: new Map(),
                currentAgentContext: new Map(),
                sessionContextUsage: new Map(),
                sessionAgentEditModes: new Map(),
                hasHydrated: typeof window === "undefined",

                clearSessionContext: (sessionId: string) => {
                    if (!sessionId || sessionId === GLOBAL_EDIT_MODE_SESSION_ID) return;

                    cancelDeferredContextWork(sessionId);
                    set((state) => {
                        const sessionModelSelections = withoutSession(state.sessionModelSelections, sessionId);
                        const sessionAgentSelections = withoutSession(state.sessionAgentSelections, sessionId);
                        const sessionAgentModelSelections = withoutSession(state.sessionAgentModelSelections, sessionId);
                        const sessionAgentModelVariantSelections = withoutSession(state.sessionAgentModelVariantSelections, sessionId);
                        const currentAgentContext = withoutSession(state.currentAgentContext, sessionId);
                        const sessionContextUsage = withoutSession(state.sessionContextUsage, sessionId);
                        const sessionAgentEditModes = withoutSession(state.sessionAgentEditModes, sessionId);

                        if (
                            sessionModelSelections === state.sessionModelSelections
                            && sessionAgentSelections === state.sessionAgentSelections
                            && sessionAgentModelSelections === state.sessionAgentModelSelections
                            && sessionAgentModelVariantSelections === state.sessionAgentModelVariantSelections
                            && currentAgentContext === state.currentAgentContext
                            && sessionContextUsage === state.sessionContextUsage
                            && sessionAgentEditModes === state.sessionAgentEditModes
                        ) {
                            return state;
                        }

                        return {
                            sessionModelSelections,
                            sessionAgentSelections,
                            sessionAgentModelSelections,
                            sessionAgentModelVariantSelections,
                            currentAgentContext,
                            sessionContextUsage,
                            sessionAgentEditModes,
                        };
                    });
                },

                saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionModelSelections);
                        newSelections.set(sessionId, { providerId, modelId });
                        return { sessionModelSelections: newSelections };
                    });
                },

                getSessionModelSelection: (sessionId: string) => {
                    const { sessionModelSelections } = get();
                    return sessionModelSelections.get(sessionId) || null;
                },

                saveSessionAgentSelection: (sessionId: string, agentName: string) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionAgentSelections);
                        newSelections.set(sessionId, agentName);

                        // Keep a "current" agent context for components that only know sessionId.
                        // This is also used by external-session inference logic.
                        const nextAgentContext = new Map(state.currentAgentContext);
                        nextAgentContext.set(sessionId, agentName);

                        return {
                            sessionAgentSelections: newSelections,
                            currentAgentContext: nextAgentContext,
                        };
                    });
                },

                getSessionAgentSelection: (sessionId: string) => {
                    const { sessionAgentSelections } = get();
                    return sessionAgentSelections.get(sessionId) || null;
                },

                saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionAgentModelSelections);

                        let agentMap = newSelections.get(sessionId);
                        if (!agentMap) {
                            agentMap = new Map();
                        } else {

                            agentMap = new Map(agentMap);
                        }

                        agentMap.set(agentName, { providerId, modelId });

                        newSelections.set(sessionId, agentMap);

                        return { sessionAgentModelSelections: newSelections };
                    });
                },

                getAgentModelForSession: (sessionId: string, agentName: string) => {
                    const { sessionAgentModelSelections } = get();
                    const agentMap = sessionAgentModelSelections.get(sessionId);
                    if (!agentMap) return null;
                    return agentMap.get(agentName) || null;
                },

                saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionAgentModelVariantSelections);

                        let agentMap = newSelections.get(sessionId);
                        if (!agentMap) {
                            agentMap = new Map();
                        } else {
                            agentMap = new Map(agentMap);
                        }

                        let modelMap = agentMap.get(agentName);
                        if (!modelMap) {
                            modelMap = new Map();
                        } else {
                            modelMap = new Map(modelMap);
                        }

                        const modelKey = `${providerId}/${modelId}`;

                        if (variant === undefined) {
                            modelMap.delete(modelKey);

                            if (modelMap.size === 0) {
                                agentMap.delete(agentName);

                                if (agentMap.size === 0) {
                                    newSelections.delete(sessionId);
                                } else {
                                    newSelections.set(sessionId, agentMap);
                                }
                            } else {
                                agentMap.set(agentName, modelMap);
                                newSelections.set(sessionId, agentMap);
                            }
                        } else {
                            modelMap.set(modelKey, variant);
                            agentMap.set(agentName, modelMap);
                            newSelections.set(sessionId, agentMap);
                        }

                        return { sessionAgentModelVariantSelections: newSelections };
                    });
                },

                getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => {
                    const { sessionAgentModelVariantSelections } = get();
                    const agentMap = sessionAgentModelVariantSelections.get(sessionId);
                    if (!agentMap) return undefined;
                    const modelMap = agentMap.get(agentName);
                    if (!modelMap) return undefined;
                    return modelMap.get(`${providerId}/${modelId}`);
                },
 
                getContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity, messages: Map<string, { info: any; parts: any[] }[]>) => {
                    if (!sessionId) return null;
                    const sessionMessages = messages.get(sessionId) || [];
                    const nextUsage = getContextUsageFromMessages(sessionMessages, capacity);
                    if (!nextUsage) return get().sessionContextUsage.get(sessionId) as ContextUsage | undefined || null;

                    const scheduleUsageUpdate = (usage: ContextUsage) => {
                        const work = registerDeferredContextWork(sessionId);
                        const runUpdate = () => {
                            try {
                                if (work.cancelled) return;
                                set((state) => {
                                    const existing = state.sessionContextUsage.get(sessionId) as ContextUsage | undefined;
                                    if (isSameSessionContextUsage(existing, usage)) {
                                        return state;
                                    }

                                    const newContextUsage = new Map(state.sessionContextUsage);
                                    newContextUsage.set(sessionId, usage);
                                    return { sessionContextUsage: newContextUsage };
                                });
                            } finally {
                                releaseDeferredContextWork(sessionId, work);
                            }
                        };

                        if (typeof queueMicrotask === 'function') {
                            queueMicrotask(runUpdate);
                        } else {
                            scheduleDeferredContextTimer(work, runUpdate, 0);
                        }
                    };

                    const cachedUsage = get().sessionContextUsage.get(sessionId) as ContextUsage | undefined;
                    if (isSameSessionContextUsage(cachedUsage, nextUsage)) {
                        return cachedUsage ?? nextUsage;
                    }

                    scheduleUsageUpdate(nextUsage);

                    return nextUsage;
                },

                updateSessionContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity, messages: Map<string, { info: any; parts: any[] }[]>) => {
                    const sessionMessages = messages.get(sessionId) || [];
                    const usage = getContextUsageFromMessages(sessionMessages, capacity);
                    if (!usage) return;

                    set((state) => {
                        const existing = state.sessionContextUsage.get(sessionId) as ContextUsage | undefined;
                        if (isSameSessionContextUsage(existing, usage)) return state;
                        const newContextUsage = new Map(state.sessionContextUsage);
                        newContextUsage.set(sessionId, usage);
                        return { sessionContextUsage: newContextUsage };
                    });
                },

                initializeSessionContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity, messages: Map<string, { info: any; parts: any[] }[]>) => {
                    const state = get();
                    const existingUsage = state.sessionContextUsage.get(sessionId);

                    if (!existingUsage || existingUsage.activeInputTokens === 0) {
                        get().updateSessionContextUsage(sessionId, capacity, messages);
                    }
                },

                pollForTokenUpdates: (sessionId: string, messageId: string, messages: Map<string, { info: any; parts: any[] }[]>, maxAttempts: number = 10) => {
                    let attempts = 0;
                    const work = registerDeferredContextWork(sessionId);

                    const poll = () => {
                        attempts++;
                        const sessionMessages = messages.get(sessionId) || [];
                        const message = sessionMessages.find(m => m.info.id === messageId);

                        if (message && message.info.role === 'assistant') {
                            const totalTokens = extractTokenBreakdownFromMessage(message).total;

                            if (totalTokens > 0) {

                                get().updateSessionContextUsage(sessionId, UNAVAILABLE_MODEL_CONTEXT_CAPACITY, messages);
                                releaseDeferredContextWork(sessionId, work);
                                return;
                            }
                        }

                        if (attempts < maxAttempts) {
                            scheduleDeferredContextTimer(work, poll, 1000);
                        } else {
                            releaseDeferredContextWork(sessionId, work);
                        }
                    };

                    scheduleDeferredContextTimer(work, poll, 2000);
                },

                getCurrentAgent: (sessionId: string) => {
                    const { currentAgentContext } = get();
                    return currentAgentContext.get(sessionId);
                },

                getSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode: EditPermissionMode = getAgentDefaultEditPermission(agentName)) => {
                    if (!sessionId || !agentName) {
                        return defaultMode;
                    }

                    const sessionMap = get().sessionAgentEditModes.get(sessionId);
                    const override = sessionMap?.get(agentName);
                    if (override !== undefined) {
                        return override;
                    }

                    // Fallback: global (applies to all sessions)
                    if (sessionId !== GLOBAL_EDIT_MODE_SESSION_ID) {
                        const globalMap = get().sessionAgentEditModes.get(GLOBAL_EDIT_MODE_SESSION_ID);
                        const globalOverride = globalMap?.get(agentName);
                        if (globalOverride !== undefined) {
                            return globalOverride;
                        }
                    }

                    return defaultMode;
                },

                setSessionAgentEditMode: (sessionId: string, agentName: string | undefined, mode: EditPermissionMode, defaultMode: EditPermissionMode = getAgentDefaultEditPermission(agentName)) => {
                    if (!sessionId || !agentName) {
                        return;
                    }

                    const normalizedDefault: EditPermissionMode = defaultMode ?? 'ask';
                    if (normalizedDefault === 'deny' || mode === 'deny') {
                        return;
                    }

                    if (!EDIT_PERMISSION_SEQUENCE.includes(mode)) {
                        return;
                    }

                    set((state) => {
                        const nextMap = new Map(state.sessionAgentEditModes);
                        const agentMap = new Map(nextMap.get(sessionId) ?? new Map());

                        if (mode === normalizedDefault) {
                            agentMap.delete(agentName);
                            if (agentMap.size === 0) {
                                nextMap.delete(sessionId);
                            } else {
                                nextMap.set(sessionId, agentMap);
                            }
                        } else {
                            agentMap.set(agentName, mode);
                            nextMap.set(sessionId, agentMap);
                        }

                        return { sessionAgentEditModes: nextMap };
                    });
                },

                toggleSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode: EditPermissionMode = getAgentDefaultEditPermission(agentName)) => {
                    if (!sessionId || !agentName) {
                        return;
                    }

                    const normalizedDefault: EditPermissionMode = defaultMode ?? 'ask';
                    if (normalizedDefault === 'deny') {
                        return;
                    }

                    const currentMode = get().getSessionAgentEditMode(sessionId, agentName, normalizedDefault);
                    const currentIndex = EDIT_PERMISSION_SEQUENCE.indexOf(currentMode);
                    const fallbackIndex = EDIT_PERMISSION_SEQUENCE.indexOf(normalizedDefault);
                    const baseIndex = currentIndex >= 0 ? currentIndex : (fallbackIndex >= 0 ? fallbackIndex : 0);
                    const nextIndex = (baseIndex + 1) % EDIT_PERMISSION_SEQUENCE.length;
                    const nextMode = EDIT_PERMISSION_SEQUENCE[nextIndex];

                    get().setSessionAgentEditMode(sessionId, agentName, nextMode, normalizedDefault);
                },

            }),
            {
                name: "context-store",
                version: CONTEXT_STORE_VERSION,
                storage: createJSONStorage(() => getSafeStorage()),
                migrate: (persistedState: any) => {
                    if (!persistedState?.sessionContextUsage) return persistedState;
                    return {
                        ...persistedState,
                        sessionContextUsage: persistedState.sessionContextUsage.map(([sessionId, usage]: [string, unknown]) => [
                            sessionId,
                            migratePersistedContextUsage(usage),
                        ]).filter((entry: [string, ContextUsage | null]) => entry[1] !== null),
                    };
                },
                partialize: (state) => ({
                    sessionModelSelections: Array.from(state.sessionModelSelections.entries()),
                    sessionAgentSelections: Array.from(state.sessionAgentSelections.entries()),
                    sessionAgentModelSelections: Array.from(state.sessionAgentModelSelections.entries()).map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())]),
                    sessionAgentModelVariantSelections: Array.from(state.sessionAgentModelVariantSelections.entries()).map(([sessionId, agentMap]) => [
                        sessionId,
                        Array.from(agentMap.entries()).map(([agentName, modelMap]) => [agentName, Array.from(modelMap.entries())]),
                    ]),
                    currentAgentContext: Array.from(state.currentAgentContext.entries()),
                    sessionContextUsage: Array.from(state.sessionContextUsage.entries()),
                    sessionAgentEditModes: Array.from(state.sessionAgentEditModes.entries()).map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())]),
                }),
                merge: (persistedState: any, currentState) => {

                    const agentModelSelections = new Map();
                    if (persistedState?.sessionAgentModelSelections) {
                        persistedState.sessionAgentModelSelections.forEach(([sessionId, agentArray]: [string, any[]]) => {
                            agentModelSelections.set(sessionId, new Map(agentArray));
                        });
                    }

                    const agentModelVariantSelections = new Map();
                    if (persistedState?.sessionAgentModelVariantSelections) {
                        persistedState.sessionAgentModelVariantSelections.forEach(([sessionId, agentArray]: [string, any[]]) => {
                            const agentMap = new Map();
                            agentArray.forEach(([agentName, modelArray]: [string, any[]]) => {
                                agentMap.set(agentName, new Map(modelArray));
                            });
                            agentModelVariantSelections.set(sessionId, agentMap);
                        });
                    }
 
                    const agentEditModes = new Map();
                    if (persistedState?.sessionAgentEditModes) {
                        persistedState.sessionAgentEditModes.forEach(([sessionId, agentArray]: [string, any[]]) => {
                            agentEditModes.set(sessionId, new Map(agentArray));
                        });
                    }

                    return {
                        ...currentState,
                        ...(persistedState as object),
                        sessionModelSelections: new Map(persistedState?.sessionModelSelections || []),
                        sessionAgentSelections: new Map(persistedState?.sessionAgentSelections || []),
                        sessionAgentModelSelections: agentModelSelections,
                        sessionAgentModelVariantSelections: agentModelVariantSelections,
                        currentAgentContext: new Map(persistedState?.currentAgentContext || []),
                        sessionContextUsage: new Map(
                            (persistedState?.sessionContextUsage || [])
                                .map(([sessionId, usage]: [string, unknown]) => [sessionId, migratePersistedContextUsage(usage)])
                                .filter((entry: [string, ContextUsage | null]) => entry[1] !== null),
                        ),
                        sessionAgentEditModes: agentEditModes,
                        hasHydrated: true,
                    };
                },
            }
        ),
        {
            name: "context-store",
        }
    )
);
