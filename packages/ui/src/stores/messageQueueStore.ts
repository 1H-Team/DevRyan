import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { devtools } from './utils/devtoolsGate';
import { getSafeStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';

// Only in-flight dispatches are retained. Clearing/removing a session invalidates
// rollback so an outstanding transport cannot resurrect its discarded queue.
const dispatches = new Map<string, Set<{ current: boolean }>>();
export function trackQueuedDispatch(sessionId: string) {
    const claim = { current: true };
    const claims = dispatches.get(sessionId) ?? new Set<{ current: boolean }>();
    claims.add(claim);
    dispatches.set(sessionId, claims);
    return {
        isCurrent: () => claim.current,
        release: () => {
            claims.delete(claim);
            if (dispatches.get(sessionId) === claims && claims.size === 0) dispatches.delete(sessionId);
        },
    };
}
function invalidateQueuedDispatches(sessionId: string) {
    for (const claim of dispatches.get(sessionId) ?? []) claim.current = false;
    dispatches.delete(sessionId);
}

export interface QueuedMessage {
    id: string;
    /** Canonical user-message ID assigned immediately before this row's first dispatch attempt. */
    messageId?: string;
    /** Distinguishes dispatch-safe IDs from legacy queue-time IDs that can sort before newer turns. */
    messageIdScope?: 'dispatch';
    /** Frozen admission intent for idempotent retry after an ambiguous response. */
    dispatchDelivery?: 'queue' | 'steer';
    /** Session directory captured at queue time; absent only on legacy persisted rows. */
    directory?: string;
    content: string;
    attachments?: AttachedFile[];
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string | null;
        planMode?: boolean;
    };
}

export interface QueuedMessageClaim {
    message: QueuedMessage;
    index: number;
}

// Claimed rows stay in the persisted FIFO until transport is acknowledged.
// They are hidden from live senders but recovered on reload with the same ID.
const durableClaims = new Map<string, Map<string, QueuedMessageClaim>>();
const retainClaim = (sessionId: string, claim: QueuedMessageClaim) => {
    const claims = durableClaims.get(sessionId) ?? new Map<string, QueuedMessageClaim>();
    claims.set(claim.message.id, claim);
    durableClaims.set(sessionId, claims);
};
const shiftClaimsAfterRemoval = (sessionId: string, index: number) => {
    if (index < 0) return;
    for (const claim of durableClaims.get(sessionId)?.values() ?? []) {
        if (claim.index > index) claim.index -= 1;
    }
};
const releaseClaim = (sessionId: string, messageId: string, accepted = false) => {
    const claims = durableClaims.get(sessionId);
    const removed = claims?.get(messageId);
    claims?.delete(messageId);
    if (accepted && removed) shiftClaimsAfterRemoval(sessionId, removed.index);
    if (claims?.size === 0) durableClaims.delete(sessionId);
};
const persistedQueue = (queues: Record<string, QueuedMessage[]>) => {
    const result = { ...queues };
    for (const [sessionId, claims] of durableClaims) {
        const queue = [...(result[sessionId] ?? [])];
        for (const claim of [...claims.values()].sort((a, b) => a.index - b.index)) {
            if (!queue.some(message => message.id === claim.message.id)) queue.splice(Math.min(claim.index, queue.length), 0, claim.message);
        }
        result[sessionId] = queue;
    }
    return result;
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // sessionId → queue
    queueModeEnabled: boolean; // global toggle
}

interface MessageQueueActions {
    updateClaimedMessage: (sessionId: string, message: QueuedMessage) => void;
    acknowledgeClaimedMessage: (sessionId: string, messageId: string) => void;
    addToQueue: (sessionId: string, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => void;
    removeFromQueue: (sessionId: string, messageId: string) => void;
    claimMessageForSession: (sessionId: string, messageId: string) => QueuedMessageClaim | null;
    restoreClaimedMessage: (sessionId: string, claim: QueuedMessageClaim) => void;
    claimQueueForSession: (sessionId: string) => QueuedMessage[];
    restoreClaimedQueue: (sessionId: string, messages: QueuedMessage[]) => void;
    popToInput: (sessionId: string, messageId: string) => QueuedMessage | null;
    clearQueue: (sessionId: string) => void;
    clearAllQueues: () => void;
    setQueueMode: (enabled: boolean) => void;
    getQueueForSession: (sessionId: string) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                queueModeEnabled: true,

                updateClaimedMessage: (sessionId, message) => {
                    const claim = durableClaims.get(sessionId)?.get(message.id);
                    if (!claim) return;
                    retainClaim(sessionId, { ...claim, message });
                    set(state => ({ queuedMessages: state.queuedMessages }));
                },
                acknowledgeClaimedMessage: (sessionId, messageId) => {
                    releaseClaim(sessionId, messageId, true);
                    set(state => ({ queuedMessages: state.queuedMessages }));
                },

                addToQueue: (sessionId, message) => {
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        directory: message.directory,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: [...currentQueue, queuedMessage],
                            },
                        };
                    });
                },

                removeFromQueue: (sessionId, messageId) => {
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        if (currentQueue.some(message => message.id === messageId)) {
                            shiftClaimsAfterRemoval(sessionId, (persistedQueue(state.queuedMessages)[sessionId] ?? []).findIndex(message => message.id === messageId));
                        }
                        const newQueue = currentQueue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });
                },

                claimMessageForSession: (sessionId, messageId) => {
                    let claim: QueuedMessageClaim | null = null;
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        const index = currentQueue.findIndex((message) => message.id === messageId);
                        if (index < 0) {
                            return state;
                        }

                        const message = currentQueue[index];
                        claim = { message, index: (persistedQueue(state.queuedMessages)[sessionId] ?? []).findIndex(row => row.id === message.id) };
                        retainClaim(sessionId, claim);
                        const newQueue = currentQueue.filter((_, queueIndex) => queueIndex !== index);
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }

                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });
                    return claim;
                },

                restoreClaimedMessage: (sessionId, claim) => {
                    const position = durableClaims.get(sessionId)?.get(claim.message.id)?.index ?? claim.index;
                    releaseClaim(sessionId, claim.message.id);
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        if (currentQueue.some((message) => message.id === claim.message.id)) {
                            return state;
                        }

                        const hiddenBefore = [...(durableClaims.get(sessionId)?.values() ?? [])].filter(row => row.index < position).length;
                        const insertionIndex = Math.min(Math.max(position - hiddenBefore, 0), currentQueue.length);
                        const restoredQueue = [...currentQueue];
                        restoredQueue.splice(insertionIndex, 0, claim.message);
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: restoredQueue,
                            },
                        };
                    });
                },

                claimQueueForSession: (sessionId) => {
                    let claimedQueue: QueuedMessage[] = [];
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        if (currentQueue.length === 0) {
                            return state;
                        }

                        claimedQueue = currentQueue;
                        const fullQueue = persistedQueue(state.queuedMessages)[sessionId] ?? [];
                        currentQueue.forEach(message => retainClaim(sessionId, { message, index: fullQueue.findIndex(row => row.id === message.id) }));
                        const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                    return claimedQueue;
                },

                restoreClaimedQueue: (sessionId, messages) => {
                    messages.forEach(message => releaseClaim(sessionId, message.id));
                    if (messages.length === 0) {
                        return;
                    }

                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        const currentIds = new Set(currentQueue.map((message) => message.id));
                        const messagesToRestore = messages.filter((message) => !currentIds.has(message.id));

                        if (messagesToRestore.length === 0) {
                            return state;
                        }

                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: [...messagesToRestore, ...currentQueue],
                            },
                        };
                    });
                },

                popToInput: (sessionId, messageId) => {
                    const state = get();
                    const currentQueue = state.queuedMessages[sessionId] ?? [];
                    const message = currentQueue.find((m) => m.id === messageId);
                    
                    if (!message) {
                        return null;
                    }

                    // Remove from queue
                    set((prevState) => {
                        const queue = prevState.queuedMessages[sessionId] ?? [];
                        shiftClaimsAfterRemoval(sessionId, (persistedQueue(prevState.queuedMessages)[sessionId] ?? []).findIndex(row => row.id === messageId));
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = prevState.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...prevState.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });

                    return message;
                },

                clearQueue: (sessionId) => {
                    invalidateQueuedDispatches(sessionId);
                    durableClaims.delete(sessionId);
                    set((state) => {
                        const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
                    for (const sessionId of dispatches.keys()) invalidateQueuedDispatches(sessionId);
                    durableClaims.clear();
                    set({ queuedMessages: {} });
                },

                setQueueMode: (enabled) => {
                    set({ queueModeEnabled: enabled });
                    // Persist to settings.json (async, fire-and-forget)
                    void updateDesktopSettings({ queueModeEnabled: enabled });
                },

                getQueueForSession: (sessionId) => {
                    return get().queuedMessages[sessionId] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    queuedMessages: persistedQueue(state.queuedMessages),
                    queueModeEnabled: state.queueModeEnabled,
                }),
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
