import { create } from 'zustand';

export type SessionPlanFileStatus = 'saving' | 'saved' | 'error';

export interface SessionPlanFileRecord {
  sourceMessageId: string;
  path: string | null;
  status: SessionPlanFileStatus;
  error: string | null;
}

interface SessionPlanFileState {
  recordsBySession: Record<string, SessionPlanFileRecord | undefined>;
  beginSaving: (sessionId: string, sourceMessageId: string) => void;
  markSaved: (sessionId: string, sourceMessageId: string, path: string) => void;
  markError: (sessionId: string, sourceMessageId: string, error: string) => void;
  clearSession: (sessionId: string) => void;
}

const clean = (value: string): string => value.trim();

export const useSessionPlanFileStore = create<SessionPlanFileState>((set) => ({
  recordsBySession: {},

  beginSaving: (sessionId, sourceMessageId) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    if (!id || !messageId) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId === messageId && current.status === 'saving') return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: { sourceMessageId: messageId, path: null, status: 'saving', error: null },
        },
      };
    });
  },

  markSaved: (sessionId, sourceMessageId, path) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    const savedPath = clean(path);
    if (!id || !messageId || !savedPath) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId !== messageId) return state;
      if (current.status === 'saved' && current.path === savedPath && current.error === null) return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: { sourceMessageId: messageId, path: savedPath, status: 'saved', error: null },
        },
      };
    });
  },

  markError: (sessionId, sourceMessageId, error) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    if (!id || !messageId) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId !== messageId) return state;
      const errorText = clean(error) || 'Failed to save plan file';
      if (current.status === 'error' && current.error === errorText) return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: { sourceMessageId: messageId, path: null, status: 'error', error: errorText },
        },
      };
    });
  },

  clearSession: (sessionId) => {
    const id = clean(sessionId);
    if (!id) return;

    set((state) => {
      if (!state.recordsBySession[id]) return state;
      const recordsBySession = { ...state.recordsBySession };
      delete recordsBySession[id];
      return { recordsBySession };
    });
  },
}));
