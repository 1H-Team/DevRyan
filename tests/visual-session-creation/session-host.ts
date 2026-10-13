import { create } from 'zustand';

export const useSessionUIStore = create<{
    abortControllers: Map<string, AbortController>;
    setCurrentSession: (sessionId: string) => void;
}>(() => ({
    abortControllers: new Map(),
    setCurrentSession: (sessionId: string) => { document.getElementById('selection')!.textContent = `Selected ${sessionId}`; },
}));
