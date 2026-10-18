import { describe, expect, it, vi } from 'vitest';

import { createCanonicalOpenCodeEventProcessor, createSyntheticOpenCodeEventEmitter } from './canonical-ingestion.js';

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
      processSessionTitle: vi.fn(async () => undefined),
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

  it('forwards authoritative session events to the title runtime', async () => {
    const processSessionTitle = vi.fn(async () => true);
    const processEvent = createCanonicalOpenCodeEventProcessor({ processSessionTitle });
    const payload = {
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    };

    processEvent(payload);
    await Promise.resolve();

    expect(processSessionTitle).toHaveBeenCalledOnce();
    expect(processSessionTitle).toHaveBeenCalledWith(payload);
  });
});


it('forwards authoritative event directory to the journal and session receipt host', () => {
  const recordJournalEvent = vi.fn();
  const process = createCanonicalOpenCodeEventProcessor({ recordJournalEvent });
  const payload = { type: 'message.part.updated', properties: { part: { sessionID: 'ses_a' } } };
  process(payload, '/fixture/project');
  expect(recordJournalEvent).toHaveBeenCalledWith(payload, '/fixture/project');
});

it('preserves directory scope for managed assistant activity', () => {
  const processManagedOrchestration = vi.fn();
  const process = createCanonicalOpenCodeEventProcessor({ processManagedOrchestration });
  const payload = { type: 'message.updated', properties: { info: { sessionID: 'child' } } };
  process(payload, '/fixture/project');
  expect(processManagedOrchestration).toHaveBeenCalledWith(payload, '/fixture/project');
});

describe('canonical ingestion observation isolation', () => {
  it('a sync throw in an observational step never skips later deliveries', async () => {
    const logger = { warn: vi.fn() }, order = [];
    const step = (name, fail) => () => { order.push(name); if (fail) throw new Error(`${name} failed`); };
    const processEvent = createCanonicalOpenCodeEventProcessor({
      cacheSessionInfo: step('cache', true), sendPush: step('push'), processSessionState: step('state'),
      processTurnTiming: step('timing', true), recordJournalEvent: step('journal'), processEvidence: step('evidence'),
      processSessionTitle: step('title'), logger,
    });
    processEvent({ type: 'message.updated', properties: {} });
    expect(order).toEqual(['cache', 'push', 'state', 'timing', 'journal', 'evidence', 'title']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps authority-bearing session state failures propagating as before', () => {
    const recordJournalEvent = vi.fn();
    const processEvent = createCanonicalOpenCodeEventProcessor({
      processSessionState: () => { throw new Error('state owner failed'); }, recordJournalEvent,
    });
    expect(() => processEvent({ type: 'session.status', properties: {} })).toThrow('state owner failed');
    expect(recordJournalEvent).not.toHaveBeenCalled();
  });
});

describe('createSyntheticOpenCodeEventEmitter', () => {
  it('keeps its order and always reaches the UI broadcast after observational failures', async () => {
    const logger = { warn: vi.fn() }, order = [];
    const emit = createSyntheticOpenCodeEventEmitter({
      processManagedOrchestration: (_payload, directory) => order.push(`orchestration:${directory}`),
      cacheSessionInfo: () => { order.push('cache'); throw new Error('cache'); },
      processSessionState: () => order.push('state'),
      processTurnTiming: () => { order.push('timing'); throw new Error('timing'); },
      recordJournalEvent: (_payload, directory) => order.push(`journal:${directory}`),
      recordMultiUserActivity: () => { order.push('activity'); throw new Error('activity'); },
      processEvidence: async () => { order.push('evidence'); throw new Error('evidence'); },
      broadcast: (_payload, options) => order.push(`broadcast:${options.directory}`),
      logger,
    });
    emit({ type: 'session.idle', properties: {} }, { directory: '/repo' });
    await Promise.resolve();
    expect(order).toEqual(['orchestration:/repo', 'cache', 'state', 'timing', 'journal:/repo', 'activity', 'evidence', 'broadcast:/repo']);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('keeps authority-bearing orchestration and session state failures propagating', () => {
    const broadcast = vi.fn();
    expect(() => createSyntheticOpenCodeEventEmitter({ processManagedOrchestration: () => { throw new Error('owner'); }, broadcast })({})).toThrow('owner');
    expect(() => createSyntheticOpenCodeEventEmitter({ processSessionState: () => { throw new Error('state'); }, broadcast })({})).toThrow('state');
    expect(broadcast).not.toHaveBeenCalled();
  });
});
