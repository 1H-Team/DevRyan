import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';

import { persistSessionPlanRevision } from './sessionPlanPersistence';
import type { SessionPlanFileStorage } from './sessionPlanFile';

const identity = {
  projectPath: '/Users/example/Repositories/Test',
  sessionCreated: 1_721_234_567_890,
  sessionSlug: 'Plan persistence',
  sourceMessageId: 'msg-plan-1',
};

const createStorage = (overrides: Partial<SessionPlanFileStorage> = {}): SessionPlanFileStorage => ({
  resolveHomeDirectory: async () => '/Users/example',
  statFile: async () => ({ exists: false, isFile: false }),
  createDirectory: async () => undefined,
  writeFile: async () => undefined,
  ...overrides,
});

describe('session plan persistence coordinator', () => {
  beforeEach(() => {
    useSessionPlanFileStore.setState({ recordsBySession: {} });
  });

  test('deduplicates concurrent saves for the same plan revision', async () => {
    let releaseWrite: () => void = () => {};
    let markWriteStarted: (() => void) | null = null;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let writeCount = 0;
    const storage = createStorage({
      writeFile: async () => {
        writeCount += 1;
        markWriteStarted?.();
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      },
    });

    const first = persistSessionPlanRevision({
      sessionId: 'session-a',
      identity,
      markdown: '# Plan',
    }, { storage });
    const second = persistSessionPlanRevision({
      sessionId: 'session-a',
      identity,
      markdown: '# Plan',
    }, { storage });

    expect(second).toBe(first);
    await writeStarted;
    expect(writeCount).toBe(1);
    releaseWrite();
    await Promise.all([first, second]);
    const record = useSessionPlanFileStore.getState().recordsBySession['session-a'];
    expect(record?.status).toBe('saved');
    expect(record?.revisionIdentity).toEqual({
      sessionId: 'session-a',
      sourceMessageId: identity.sourceMessageId,
      directory: identity.projectPath,
      sessionCreated: identity.sessionCreated,
      sessionSlug: identity.sessionSlug,
    });
  });

  test('reuses an existing file and skips subsequent saved-revision work', async () => {
    let statCount = 0;
    let writeCount = 0;
    const storage = createStorage({
      statFile: async () => {
        statCount += 1;
        return { exists: true, isFile: true };
      },
      writeFile: async () => {
        writeCount += 1;
      },
    });

    const first = await persistSessionPlanRevision({
      sessionId: 'session-a',
      identity,
      markdown: '# Plan',
    }, { storage });
    const second = await persistSessionPlanRevision({
      sessionId: 'session-a',
      identity,
      markdown: '# Changed renderer text',
    }, { storage });

    expect(first.status).toBe('saved');
    expect(second).toEqual(first);
    expect(statCount).toBe(1);
    expect(writeCount).toBe(0);
  });

  test('keeps failures stable until an explicit retry succeeds', async () => {
    let attempts = 0;
    const storage = createStorage({
      writeFile: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      },
    });
    const input = { sessionId: 'session-a', identity, markdown: '# Plan' };

    const failed = await persistSessionPlanRevision(input, { storage });
    const skipped = await persistSessionPlanRevision(input, { storage });
    const retried = await persistSessionPlanRevision(input, { storage, retry: true });

    expect(failed.status).toBe('error');
    expect(failed.error).toBe('disk full');
    expect(skipped).toEqual(failed);
    expect(retried.status).toBe('saved');
    expect(attempts).toBe(2);
  });

  test('does not let a late older revision replace the latest saved pointer', async () => {
    let releaseOldWrite: () => void = () => {};
    let markOldWriteStarted: (() => void) | null = null;
    const oldWriteStarted = new Promise<void>((resolve) => {
      markOldWriteStarted = resolve;
    });
    const oldStorage = createStorage({
      writeFile: async () => {
        markOldWriteStarted?.();
        await new Promise<void>((resolve) => {
          releaseOldWrite = resolve;
        });
      },
    });
    const newIdentity = { ...identity, sourceMessageId: 'msg-plan-2' };

    const oldSave = persistSessionPlanRevision({
      sessionId: 'session-a',
      identity,
      markdown: '# Old plan',
    }, { storage: oldStorage });
    await oldWriteStarted;
    await persistSessionPlanRevision({
      sessionId: 'session-a',
      identity: newIdentity,
      markdown: '# New plan',
    }, { storage: createStorage() });
    releaseOldWrite();
    await oldSave;

    const record = useSessionPlanFileStore.getState().recordsBySession['session-a'];
    expect(record?.sourceMessageId).toBe('msg-plan-2');
    expect(record?.status).toBe('saved');
    expect(record?.revisionIdentity?.sourceMessageId).toBe('msg-plan-2');
  });
});
