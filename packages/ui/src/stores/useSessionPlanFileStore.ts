import { create } from 'zustand';

export type SessionPlanFileStatus = 'saving' | 'saved' | 'error';

export interface SessionPlanFileRecord {
  sourceMessageId: string;
  path: string | null;
  status: SessionPlanFileStatus;
  error: string | null;
  autoRevealed?: boolean;
}

interface SessionPlanFileState {
  recordsBySession: Record<string, SessionPlanFileRecord | undefined>;
  beginSaving: (sessionId: string, sourceMessageId: string) => void;
  markSaved: (sessionId: string, sourceMessageId: string, path: string) => void;
  markError: (sessionId: string, sourceMessageId: string, error: string) => void;
  claimAutoReveal: (sessionId: string, sourceMessageId: string) => boolean;
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
          [id]: { sourceMessageId: messageId, path: null, status: 'saving', error: null, autoRevealed: false },
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
          [id]: {
            sourceMessageId: messageId,
            path: savedPath,
            status: 'saved',
            error: null,
            autoRevealed: current.autoRevealed === true,
          },
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
          [id]: {
            sourceMessageId: messageId,
            path: null,
            status: 'error',
            error: errorText,
            autoRevealed: current.autoRevealed === true,
          },
        },
      };
    });
  },

  claimAutoReveal: (sessionId, sourceMessageId) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    if (!id || !messageId) return false;

    let claimed = false;
    set((state) => {
      const current = state.recordsBySession[id];
      if (
        !current
        || current.sourceMessageId !== messageId
        || current.status !== 'saved'
        || !current.path
        || current.autoRevealed === true
      ) {
        return state;
      }

      claimed = true;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: { ...current, autoRevealed: true },
        },
      };
    });
    return claimed;
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
