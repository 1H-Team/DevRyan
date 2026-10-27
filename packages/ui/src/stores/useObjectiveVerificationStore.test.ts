import { afterEach, expect, test } from 'bun:test';
import { managedOrchestrationApi } from '@/lib/orchestrationApi';
import { objectiveVerificationKey, useObjectiveVerificationStore } from './useObjectiveVerificationStore';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
};

const original = managedOrchestrationApi.getObjectiveVerification;
afterEach(() => { managedOrchestrationApi.getObjectiveVerification = original; useObjectiveVerificationStore.setState({ entries: {} }); });

test('coalesces panel reads but fresh completion proof supersedes an older request', async () => {
  const first = deferred<unknown>(), second = deferred<unknown>();
  let calls = 0;
  managedOrchestrationApi.getObjectiveVerification = async () => ++calls === 1 ? first.promise : second.promise;
  const store = useObjectiveVerificationStore.getState();
  const panel = store.refresh('ses_root', '/project');
  const duplicate = store.refresh('ses_root', '/project');
  expect(panel).toBe(duplicate);
  const gate = store.refresh('ses_root', '/project', { expectedObjectiveId: 'msg_new', force: true });
  second.resolve({ objectiveId: 'msg_new', verification: null });
  expect(await gate).toEqual({ objectiveId: 'msg_new', verification: null });
  first.resolve({ objectiveId: 'msg_old', verification: null });
  expect(await panel).toBeNull();
  expect(useObjectiveVerificationStore.getState().entries[objectiveVerificationKey('ses_root', '/project')]).toMatchObject({ status: 'confirmed', proof: { objectiveId: 'msg_new' } });
  expect(calls).toBe(2);
});

test('never treats missing, malformed, mismatched or unavailable proof as complete', async () => {
  const store = useObjectiveVerificationStore.getState();
  for (const value of [{}, { objectiveId: 'msg_other', verification: null }, { objectiveId: 'msg_expected' },
    { objectiveId: 'msg_expected', verification: {} }]) {
    managedOrchestrationApi.getObjectiveVerification = async () => value;
    expect(await store.refresh('ses_root', '/project', { expectedObjectiveId: 'msg_expected', force: true })).toBeNull();
    expect(useObjectiveVerificationStore.getState().entries[objectiveVerificationKey('ses_root', '/project')]?.status).toBe('error');
  }
  managedOrchestrationApi.getObjectiveVerification = async () => { throw Error('offline'); };
  expect(await store.refresh('ses_root', '/project', { expectedObjectiveId: 'msg_expected', force: true })).toBeNull();
});

test('requires a server-attested current turn when resolving continuation ownership', async () => {
  const store = useObjectiveVerificationStore.getState();
  for (const value of [{ objectiveId: 'msg_human', verification: null },
    { objectiveId: 'msg_human', originatingMessageId: 'msg_foreign', verification: null }]) {
    managedOrchestrationApi.getObjectiveVerification = async () => value;
    expect(await store.refresh('ses_root', '/project', { originatingMessageId: 'msg_wake', force: true })).toBeNull();
  }
  managedOrchestrationApi.getObjectiveVerification = async () => ({ objectiveId: 'msg_human', originatingMessageId: 'msg_wake', verification: null });
  expect(await store.refresh('ses_root', '/project', { originatingMessageId: 'msg_wake', force: true })).toEqual({ objectiveId: 'msg_human', verification: null });
});
