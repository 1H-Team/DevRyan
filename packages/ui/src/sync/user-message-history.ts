import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { messagesBefore } from './message-order';
import { getEffectiveSessionRevertMessageID } from './revert-transactions';
import type { State } from './types';
import { useMemo, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';

type HistoryState = Pick<State, 'message' | 'part' | 'session' | 'revert_transaction'>;
type HistoryRecord = { info: Message; parts: Part[] };

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PARTS: Part[] = [];
const EMPTY_HISTORY: string[] = [];

const firstText = (parts: Part[]): string => {
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) return part.text;
  }
  return '';
};

export function buildUserMessageHistory(records: HistoryRecord[]): string[] {
  const history: string[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.info.role !== 'user') continue;
    const text = firstText(record.parts);
    if (text.length > 0) history.push(text);
  }
  return history;
}

/** One hook/store/session owns this cache; assistant part updates never rebuild history. */
export function createUserMessageHistorySelector(sessionID: string): (state: HistoryState) => string[] {
  let sourceMessages: Message[] | undefined;
  let revertMessageID: string | undefined;
  let records: HistoryRecord[] = [];
  let history = EMPTY_HISTORY;

  return (state) => {
    const messages = state.message[sessionID] ?? EMPTY_MESSAGES;
    const revert = getEffectiveSessionRevertMessageID(state, sessionID);
    if (sourceMessages === messages && revertMessageID === revert
      && records.every((record) => record.parts === (state.part[record.info.id] ?? EMPTY_PARTS))) {
      return history;
    }

    sourceMessages = messages;
    revertMessageID = revert;
    records = (revert ? messagesBefore(messages, revert) : messages)
      .filter((message) => message.role === 'user')
      .map((info) => ({ info, parts: state.part[info.id] ?? EMPTY_PARTS }));
    const next = buildUserMessageHistory(records);
    if (next.length === 0) history = EMPTY_HISTORY;
    else if (next.length !== history.length || next.some((text, index) => text !== history[index])) history = next;
    return history;
  };
}

/** Store identity follows directory selection; changing either identity drops the old cache. */
export function useUserMessageHistorySnapshot(store: Pick<StoreApi<HistoryState>, 'getState' | 'subscribe'>, sessionID: string): string[] {
  const getSnapshot = useMemo(() => {
    const select = createUserMessageHistorySelector(sessionID);
    return () => select(store.getState());
  }, [store, sessionID]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
