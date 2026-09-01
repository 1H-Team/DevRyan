export const useSessionUIStore = { getState: () => ({
    setCurrentSession: (sessionId: string) => { document.getElementById('selection')!.textContent = `Selected ${sessionId}`; },
}) };
