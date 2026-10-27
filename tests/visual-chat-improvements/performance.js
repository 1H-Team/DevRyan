// Synthetic control uses the previous broad record subscription; both arms run
// the same production reducer, snapshots, data, and explicit settlement cleanup.
import { createStore } from 'zustand/vanilla';
import { INITIAL_STATE } from '@/sync/types';
import { createEventDraft } from '@/sync/event-batch';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { buildSessionMessageRecordsSnapshot } from '@/sync/sync-context';
import { subscribeSessionRecords } from '@/sync/session-record-subscription';
import { dropSessionCaches } from '@/sync/session-cache';
import { resolveViewedTrimStart } from '@/sync/session-history';
let retained;
export async function profileSessionTree(mode) {
  if (!['broad-control', 'narrow'].includes(mode)) throw Error('Unknown fixture arm');
  retained = null;
  const ids = ['root', 'child-a', 'child-b'];
  const state = { ...INITIAL_STATE, session: [], message: {}, part: {}, session_status: {}, todo: {}, session_diff: {}, permission: {}, question: {} };
  const ownerByMessage = new Map();
  for (const id of ids) {
    state.session.push({ id, directory: '/fixture', ...(id === 'root' ? {} : { parentID: 'root' }), title: id, time: { created: 1, updated: 1 } });
    state.session_status[id] = { type: 'busy' };
    state.message[id] = Array.from({ length: id === 'root' ? 200 : 100 }, (_, index) => {
      const messageID = `${id}-${index}`;
      ownerByMessage.set(messageID, id);
      const user = index % 2 === 0;
      const info = { id: messageID, sessionID: id, role: user ? 'user' : 'assistant', time: { created: index + 1, ...(user ? {} : { completed: index + 2 }) } };
      state.part[messageID] = user ? [] : [{ type: 'tool', id: `tool-${messageID}`, messageID, sessionID: id, callID: messageID, tool: 'read', state: { status: 'completed', input: {}, title: 'Read fixture', output: 'x'.repeat(8192), metadata: {}, time: { start: 1, end: 2 } } }];
      return info;
    });
    const tail = state.message[id].at(-1).id;
    state.part[tail] = [{ type: 'text', id: `stream-${id}`, messageID: tail, sessionID: id, text: '' }];
  }
  const store = createStore(() => state);
  const work = { snapshotBuilds: 0, rootSnapshotBuilds: 0, events: 0, eventBytes: 0, changedEvents: 0 };
  const cleanups = [];
  for (const id of ids) for (let consumer = 0; consumer < (id === 'root' ? 3 : 2); consumer++) {
    let snapshot = buildSessionMessageRecordsSnapshot(state, id);
    const notify = () => { work.snapshotBuilds++; if (id === 'root') work.rootSnapshotBuilds++; snapshot = buildSessionMessageRecordsSnapshot(store.getState(), id, snapshot); };
    cleanups.push(mode === 'narrow' ? subscribeSessionRecords(store, id, notify) : store.subscribe(notify));
  }
  for (let index = 0; index < 1500; index++) {
    const id = ids[1 + index % 2], messageID = state.message[id].at(-1).id;
    const event = { id: `evt_fixture_${index}`, type: 'message.part.delta', properties: { sessionID: id, messageID, partID: `stream-${id}`, field: 'text', delta: 'fixture output ' } };
    work.eventBytes += new TextEncoder().encode(JSON.stringify(event)).length;
    const draft = createEventDraft(store.getState(), event);
    if (applyDirectoryEvent(draft, event, { resolveSessionIDForMessage: message => ownerByMessage.get(message) })) { store.setState(draft); work.changedEvents++; }
    work.events++;
    if (index % 50 === 49) await new Promise(resolve => requestAnimationFrame(resolve));
  }
  for (const cleanup of cleanups) cleanup();
  const settled = { ...store.getState(), session_status: {}, message: { ...store.getState().message }, part: { ...store.getState().part } };
  const liveRecords = Object.values(settled.message).reduce((sum, records) => sum + records.length, 0);
  const liveBytes = new TextEncoder().encode(JSON.stringify({ message: settled.message, part: settled.part })).length;
  dropSessionCaches(settled, ['child-a', 'child-b']);
  const rootMessages = settled.message.root;
  const keepFrom = resolveViewedTrimStart(rootMessages);
  for (const message of rootMessages.slice(0, keepFrom)) delete settled.part[message.id];
  settled.message.root = rootMessages.slice(keepFrom);
  store.setState(settled, true);
  retained = store;
  return { ...work, liveRecords, liveBytes, settledRecords: settled.message.root.length,
    settledBytes: new TextEncoder().encode(JSON.stringify({ message: settled.message, part: settled.part })).length };
}
export const releaseProfileSessionTree = () => { retained = null; };

export const profileRetainedRecords = () => retained?.getState().message.root?.length ?? 0;
