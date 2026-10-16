import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createSessionRuntime } from '../../../web/server/lib/opencode/session-runtime.js';
import { serializeEventPayload } from '../../../web/server/lib/event-stream/payload-serialization.js';

mock.module('@/components/ui', () => ({ toast: { info() {}, error() {}, success() {}, dismiss() {} } }));

import { ChildStoreManager } from './child-store';
import { INITIAL_STATE } from './types';
import { applySyncEventForTest, resyncDirectoryAfterReconnect } from './sync-context';
import { isAssistantFinalizing, useSessionPresentationStore } from './session-presentation';
import { opencodeClient } from '@/lib/opencode/client';
import { resolveStatusRowAssistantDisplay } from '@/components/chat/StatusRowContainer';

const directory = '/fixture', sessionID = 'ses_finalizing', userID = 'msg_user';
const originalFetch = globalThis.fetch;
const runtimes = [];
beforeEach(() => { useSessionPresentationStore.setState({ directories: {} }); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function fixture() {
  const manager = new ChildStoreManager();
  manager.configure({ onDispose: dir => useSessionPresentationStore.getState().clearDirectory(dir) });
  const store = manager.ensureChild(directory, { bootstrap: false });
  const session = { id: sessionID, directory, title: 'fixture', time: { created: 1, updated: 1 } };
  const user = { id: userID, sessionID, role: 'user', time: { created: 1 } };
  store.setState({ ...INITIAL_STATE, session: [session], message: { [sessionID]: [user] } });
  const routing = { sessionDirectoryById: new Map([[sessionID, directory]]),
    messageSessionById: new Map([[userID, sessionID]]), sessionMessageIdsById: new Map([[sessionID, new Set([userID])]]) };
  const apply = event => applySyncEventForTest('global', event, manager, routing);
  const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(),
    broadcastEvent: event => {
      if (event.type === 'openchamber:session-activity') apply(JSON.parse(serializeEventPayload(event)));
    } });
  runtimes.push(runtime);
  const status = type => {
    const event = { type: 'session.status', properties: { sessionID, status: { type } } };
    apply(event);
    runtime.processOpenCodeSsePayload(event);
  };
  const observation = { provider: 'native', phase: 'finalizing', ownerID: 'owner', sessionID,
    generation: 'generation', objectiveID: userID, assistantID: 'msg_assistant', stepID: 'step', attemptID: 'attempt',
    sequence: 1, progress: 1 };
  const visible = (promptID = userID) => isAssistantFinalizing(
    useSessionPresentationStore.getState().directories[directory]?.[sessionID],
    store.getState().session_status[sessionID]?.type, promptID,
  );
  return { manager, store, session, routing, runtime, status, observation, apply, visible };
}

test('actual backend envelopes route through production global event ingestion and preserve status authority', () => {
  const f = fixture();
  try {
    f.status('busy');
    expect(f.visible()).toBe(false);
    expect(f.runtime.updateSessionPresentation(f.observation)).toBe(true);
    expect(f.visible()).toBe(true);
    expect(f.store.getState().session_status[sessionID]).toEqual({ type: 'busy' });
    expect(resolveStatusRowAssistantDisplay({ isRevertPending: true, revertingText: 'Reverting',
      showWorkingPlaceholder: true, assistantStatusText: 'finalizing', assistantIsGenericStatus: false }).statusText).toBe('Reverting');
    expect(f.visible('new-optimistic-user')).toBe(false);
    f.apply({ type: 'message.updated', properties: { info: {
      id: 'new-user', sessionID, role: 'user', time: { created: 2 },
    } } });
    expect(f.visible()).toBe(false);
    f.runtime.clearSessionPresentationOwner('owner');
    expect(f.visible()).toBe(false);
    f.status('idle');
    expect(f.visible()).toBe(false);
    f.apply({ type: 'session.deleted', properties: { info: f.session } });
    expect(useSessionPresentationStore.getState().directories[directory]?.[sessionID]).toBeUndefined();
  } finally { f.manager.disposeAll(); }
});

test('real reconnect hydrates the backend snapshot and rejects a disposed/recreated directory owner', async () => {
  for (const retire of [false, true]) {
    const f = fixture();
    f.status('busy');
    f.runtime.updateSessionPresentation(f.observation);
    useSessionPresentationStore.setState({ directories: {} });
    const originalScoped = opencodeClient.getScopedSdkClient;
    const originalQuestions = opencodeClient.listPendingQuestions;
    const originalPermissions = opencodeClient.listPendingPermissions;
    opencodeClient.getScopedSdkClient = () => ({ session: {
      status: async () => ({ data: { [sessionID]: { type: 'busy' } } }),
      get: async () => ({ data: f.session }),
      messages: async () => ({ data: [{ info: f.store.getState().message[sessionID][0], parts: [] }] }),
    } });
    opencodeClient.listPendingQuestions = async () => [];
    opencodeClient.listPendingPermissions = async () => [];
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    globalThis.fetch = (_url, init) => {
      expect(init.credentials).toBe('include');
      began();
      return new Promise(resolve => { release = resolve; });
    };
    try {
      const request = resyncDirectoryAfterReconnect(directory, f.store, f.routing, {
        candidateSessionIds: [sessionID], isCurrent: () => f.manager.getChild(directory) === f.store,
      });
      await started;
      // Optional presentation reads must not delay Stop/recovery resync callers.
      await request;
      if (retire) {
        f.manager.disposeDirectory(directory);
        f.manager.ensureChild(directory, { bootstrap: false });
      }
      release(Response.json(f.runtime.getSessionActivitySnapshot()));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(f.visible()).toBe(!retire);
      if (retire) expect(useSessionPresentationStore.getState().directories[directory]).toBeUndefined();
    } finally {
      opencodeClient.getScopedSdkClient = originalScoped;
      opencodeClient.listPendingQuestions = originalQuestions;
      opencodeClient.listPendingPermissions = originalPermissions;
      f.manager.disposeAll();
    }
  }
});
