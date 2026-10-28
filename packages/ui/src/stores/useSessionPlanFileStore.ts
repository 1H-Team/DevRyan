import { create } from 'zustand';

import type { SessionPlanRevisionIdentity, SessionPlanSourceIdentity } from '@/lib/api/types';

export type SessionPlanFileStatus = 'saving' | 'saved' | 'error';

export interface SessionPlanFileRecord {
  sourceMessageId: string;
  path: string | null;
  revisionIdentity: SessionPlanRevisionIdentity | null;
  status: SessionPlanFileStatus;
  error: string | null;
  autoRevealed?: boolean;
  sourceIdentity?: SessionPlanSourceIdentity;
  canonicalContent?: string;
  version?: string;
  validationAttempt?: string;
  /** Saving waits for the run to settle; `waitingReason` is the host's reason, if named. */
  waitingFor?: 'settlement';
  waitingReason?: string | null;
}

interface SessionPlanFileState {
  recordsBySession: Record<string, SessionPlanFileRecord | undefined>;
  beginSaving: (sessionId: string, sourceMessageId: string, validationAttempt?: string) => void;
  markSaved: (
    sessionId: string,
    sourceMessageId: string,
    path: string,
    revisionIdentity: SessionPlanRevisionIdentity,
    sourceIdentity?: SessionPlanSourceIdentity,
    canonicalContent?: string,
    version?: string,
    validationAttempt?: string,
  ) => void;
  markError: (sessionId: string, sourceMessageId: string, error: string, validationAttempt?: string) => void;
  markWaiting: (sessionId: string, sourceMessageId: string, reason: string | null, validationAttempt?: string) => void;
  claimAutoReveal: (sessionId: string, sourceMessageId: string) => boolean;
  clearSession: (sessionId: string) => void;
}

const clean = (value: string): string => value.trim();

export const useSessionPlanFileStore = create<SessionPlanFileState>((set) => ({
  recordsBySession: {},

  beginSaving: (sessionId, sourceMessageId, validationAttempt) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    if (!id || !messageId) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId === messageId && current.status === 'saving' && current.validationAttempt === validationAttempt) return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: {
            sourceMessageId: messageId,
            path: null,
            revisionIdentity: null,
            validationAttempt,
            status: 'saving',
            error: null,
            autoRevealed: false,
          },
        },
      };
    });
  },

  markSaved: (sessionId, sourceMessageId, path, revisionIdentity, sourceIdentity, canonicalContent, version, validationAttempt) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    const savedPath = clean(path);
    if (
      !id
      || !messageId
      || !savedPath
      || revisionIdentity.sessionId.trim() !== id
      || revisionIdentity.sourceMessageId.trim() !== messageId
    ) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId !== messageId || validationAttempt !== undefined && current.validationAttempt !== validationAttempt) return state;
      if (
        current.status === 'saved'
        && current.path === savedPath
        && current.revisionIdentity === revisionIdentity
        && current.sourceIdentity === sourceIdentity
        && current.canonicalContent === canonicalContent
        && current.version === version
        && current.error === null
      ) return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: {
            sourceMessageId: messageId,
            path: savedPath,
            revisionIdentity,
            sourceIdentity,
            canonicalContent,
            version,
            validationAttempt: current.validationAttempt,
            status: 'saved',
            error: null,
            autoRevealed: current.autoRevealed === true,
          },
        },
      };
    });
  },

  markWaiting: (sessionId, sourceMessageId, reason, validationAttempt) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    if (!id || !messageId) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId !== messageId || validationAttempt !== undefined && current.validationAttempt !== validationAttempt) return state;
      if (current.status === 'saving' && current.waitingFor === 'settlement' && current.waitingReason === reason) return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: { ...current, status: 'saving', error: null, waitingFor: 'settlement', waitingReason: reason },
        },
      };
    });
  },

  markError: (sessionId, sourceMessageId, error, validationAttempt) => {
    const id = clean(sessionId);
    const messageId = clean(sourceMessageId);
    if (!id || !messageId) return;

    set((state) => {
      const current = state.recordsBySession[id];
      if (current?.sourceMessageId !== messageId || validationAttempt !== undefined && current.validationAttempt !== validationAttempt) return state;
      const errorText = clean(error) || 'Failed to save plan file';
      if (current.status === 'error' && current.error === errorText) return state;
      return {
        recordsBySession: {
          ...state.recordsBySession,
          [id]: {
            sourceMessageId: messageId,
            path: null,
            revisionIdentity: null,
            status: 'error',
            validationAttempt: current.validationAttempt,
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
