import { describe, expect, it, vi } from 'vitest';

import { createCanonicalOpenCodeEventProcessor } from './canonical-ingestion.js';

describe('createCanonicalOpenCodeEventProcessor', () => {
  it('runs every raw-event side effect once and owns deletion cleanup', async () => {
    const callbacks = {
      cacheSessionInfo: vi.fn(),
      sendPush: vi.fn(),
      processSessionState: vi.fn(),
      processTurnTiming: vi.fn(),
      recordJournalEvent: vi.fn(),
      recordMultiUserActivity: vi.fn(async () => undefined),
      processEvidence: vi.fn(async () => undefined),
      processBrowserLease: vi.fn(async () => undefined),
      onSessionDeleted: vi.fn(),
    };
    const processEvent = createCanonicalOpenCodeEventProcessor(callbacks);
    const payload = { type: 'session.deleted', properties: { info: { id: 'ses_1' } } };

    processEvent(payload);
    await Promise.resolve();

    for (const callback of Object.values(callbacks)) {
      expect(callback).toHaveBeenCalledOnce();
    }
  });

  it('invokes optional context-mode recovery on every raw event', () => {
    const processContextModeRecovery = vi.fn();
    const processEvent = createCanonicalOpenCodeEventProcessor({
      processContextModeRecovery,
    });
    const payload = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'ctx_batch_execute',
          state: { status: 'error', error: 'disk I/O error' },
        },
      },
    };

    processEvent(payload);

    expect(processContextModeRecovery).toHaveBeenCalledOnce();
    expect(processContextModeRecovery).toHaveBeenCalledWith(payload);
  });

  it('invokes optional command deadline recovery on every raw event', async () => {
    const processCommandDeadline = vi.fn(async () => undefined);
    const processEvent = createCanonicalOpenCodeEventProcessor({ processCommandDeadline });
    const payload = {
      type: 'message.part.updated',
      properties: { part: { type: 'tool', tool: 'bash', state: { status: 'running' } } },
    };

    processEvent(payload);
    await Promise.resolve();

    expect(processCommandDeadline).toHaveBeenCalledOnce();
    expect(processCommandDeadline).toHaveBeenCalledWith(payload);
  });
});
