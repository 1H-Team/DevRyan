import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';

export interface QueuedMessage {
    id: string;
    /** Canonical user-message ID assigned immediately before this row's first dispatch attempt. */
    messageId?: string;
    /** Distinguishes dispatch-safe IDs from legacy queue-time IDs that can sort before newer turns. */
    messageIdScope?: 'dispatch';
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
        variant?: string;
        planMode?: boolean;
    };
}

export interface QueuedMessageClaim {
    message: QueuedMessage;
    index: number;
}

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // sessionId → queue
    queueModeEnabled: boolean; // global toggle
}

interface MessageQueueActions {
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
                        claim = { message, index };
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
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        if (currentQueue.some((message) => message.id === claim.message.id)) {
                            return state;
                        }

                        const insertionIndex = Math.min(Math.max(claim.index, 0), currentQueue.length);
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
                        const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                    return claimedQueue;
                },

                restoreClaimedQueue: (sessionId, messages) => {
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
                    set((state) => {
                        const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
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
                    queuedMessages: state.queuedMessages,
                    queueModeEnabled: state.queueModeEnabled,
                }),
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
