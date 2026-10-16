import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_PRESENTATION_MAX_SESSIONS, SESSION_PRESENTATION_MAX_OWNERS, createSessionRuntime } from './session-runtime.js';

describe('session runtime', () => {
  const runtimes = [];

  afterEach(() => {
    for (const runtime of runtimes) {
      runtime.dispose();
    }
    runtimes.length = 0;
    vi.useRealTimers();
  });

  it('broadcasts attention clears through the shared broadcaster', () => {
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        events.push(payload);
      },
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: {
          type: 'busy',
        },
      },
    });
    runtime.markUserMessageSent('session-1');
    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: {
          type: 'idle',
        },
      },
    });
    runtime.markSessionViewed('session-1', 'client-1');

    expect(events).toContainEqual({
      type: 'openchamber:session-status',
      properties: expect.objectContaining({
        sessionId: 'session-1',
        sessionID: 'session-1',
        status: 'idle',
        needsAttention: true,
      }),
    });
    expect(events.at(-1)).toEqual({
      type: 'openchamber:session-status',
      properties: {
        sessionId: 'session-1',
        sessionID: 'session-1',
        status: 'idle',
        timestamp: expect.any(Number),
        metadata: {},
        needsAttention: false,
      },
    });
  });

  it('accepts legacy session.status info.type payloads', () => {
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        events.push(payload);
      },
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'legacy-session-1',
        info: {
          type: 'busy',
        },
      },
    });

    expect(events).toContainEqual({
      type: 'openchamber:session-status',
      properties: expect.objectContaining({
        sessionId: 'legacy-session-1',
        sessionID: 'legacy-session-1',
        status: 'busy',
      }),
    });
  });

  it('broadcasts idle activity after cooldown expires', () => {
    vi.useFakeTimers();
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        events.push(payload);
      },
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-activity-1',
        status: { type: 'busy' },
      },
    });
    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-activity-1',
        status: { type: 'idle' },
      },
    });

    const activityPhases = () => events
      .filter((event) => event.type === 'openchamber:session-activity')
      .map((event) => event.properties.phase);

    expect(activityPhases()).toEqual(['busy', 'cooldown']);

    vi.advanceTimersByTime(1999);
    expect(activityPhases()).toEqual(['busy', 'cooldown']);

    vi.advanceTimersByTime(1);
    expect(activityPhases()).toEqual(['busy', 'cooldown', 'idle']);
  });

  it('clears deleted session activity so it cannot block lifecycle work', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent() {},
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'deleted-session',
        status: { type: 'busy' },
      },
    });

    expect(runtime.getSessionActivitySnapshot()).toEqual({
      'deleted-session': { type: 'busy' },
    });
    expect(runtime.clearSessionActivity('deleted-session')).toBe(true);
    expect(runtime.getSessionActivitySnapshot()).toEqual({});
    expect(runtime.getSessionState('deleted-session')).toBeNull();
    expect(runtime.getSessionAttentionState('deleted-session')).toBeNull();
  });

  it('lists sessions last reported busy or retrying for restart reconciliation', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent() {},
    });
    runtimes.push(runtime);
    for (const [sessionID, type] of [['busy-session', 'busy'], ['retry-session', 'retry'], ['idle-session', 'idle']]) {
      runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID, status: { type } } });
    }

    expect(runtime.listActiveSessions().map(({ sessionId, status }) => [sessionId, status])).toEqual([
      ['busy-session', 'busy'],
      ['retry-session', 'retry'],
    ]);
    expect(runtime.listActiveSessions()[0].lastUpdateAt).toEqual(expect.any(Number));
  });
  const presentation = (overrides = {}) => ({ provider: 'native', ownerID: 'native:controller-1', sessionID: 'session-presentation',
    generation: 'generation-1', sequence: 1, objectiveID: 'msg-user', assistantID: 'msg-assistant', stepID: 'step-1', attemptID: 'trace:span',
    phase: 'finalizing', progress: 0, ...overrides });
  const presentationRuntime = () => {
    const events = [], runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent: event => events.push(event) });
    runtimes.push(runtime);
    runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'session-presentation', status: { type: 'busy' } } });
    return { runtime, events };
  };
  it('projects generation-owned Finalizing separately from busy authority and retains it in reconnect snapshots', () => {
    const { runtime, events } = presentationRuntime();
    expect(runtime.updateSessionPresentation(presentation())).toBe(true);
    const first = runtime.getSessionActivitySnapshot()['session-presentation'];
    expect(first).toMatchObject({ type: 'busy', presentationEpoch: expect.any(String), presentationRevision: 1,
      presentation: { provider: 'native', phase: 'finalizing', generation: 'generation-1', progress: 0 } });
    expect(runtime.getSessionState('session-presentation').status).toBe('busy');
    expect(runtime.updateSessionPresentation(presentation({ sequence: 2, progress: 1 }))).toBe(true);
    expect(runtime.getSessionActivitySnapshot()['session-presentation'].presentationRevision).toBeGreaterThan(first.presentationRevision);
    expect(runtime.updateSessionPresentation(presentation({ sequence: 1, progress: 2 }))).toBe(false);
    expect(runtime.updateSessionPresentation(presentation({ sequence: 3, progress: 1 }))).toBe(false);
    expect(events.at(-1).properties.phase).toBe('busy');
    expect(runtime.updateSessionPresentation(presentation({ sequence: 4, progress: 2, phase: 'cleared' }))).toBe(true);
    expect(runtime.getSessionActivitySnapshot()['session-presentation']).toMatchObject({ type: 'busy', presentation: null });
    expect(runtime.updateSessionPresentation(presentation({ sequence: 5, progress: 3 }))).toBe(false);
  });
  it('clears on a new human, idle, error, deletion and retirement without admitting stale generation callbacks', () => {
    for (const clear of [r => r.markUserMessageSent('session-presentation'),
      r => r.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'session-presentation', status: { type: 'idle' } } }),
      r => r.processOpenCodeSsePayload({ type: 'session.error', properties: { sessionID: 'session-presentation' } }),
      r => r.clearSessionActivity('session-presentation'), r => r.clearSessionPresentationOwner('native:controller-1')]) {
      const { runtime } = presentationRuntime(); runtime.updateSessionPresentation(presentation()); clear(runtime);
      expect(runtime.getSessionActivitySnapshot()['session-presentation']?.presentation ?? null).toBeNull();
      expect(runtime.updateSessionPresentation(presentation({ sequence: 2, progress: 1 }))).toBe(false);
    }
    const { runtime } = presentationRuntime();runtime.updateSessionPresentation(presentation());
    expect(runtime.updateSessionPresentation(presentation({ generation: 'generation-2', sequence: 2 }))).toBe(true);
    expect(runtime.updateSessionPresentation(presentation({ phase: 'cleared', sequence: 3 }))).toBe(false);
    expect(runtime.getSessionActivitySnapshot()['session-presentation'].presentation.generation).toBe('generation-2');
  });
  it('requires actual native step/attempt proof and permits Cursor nullable IDs only on the provider branch', () => {
    const { runtime } = presentationRuntime();
    expect(runtime.updateSessionPresentation(presentation({ stepID: null, attemptID: null }))).toBe(false);
    expect(runtime.updateSessionPresentation(presentation({ provider: 'cursor', stepID: null, attemptID: null }))).toBe(true);
    expect(runtime.updateSessionPresentation(presentation({ sessionID: 'unknown', ownerID: 'unknown', sequence: 1 }))).toBe(false);
  });
  it('bounds owners and sessions, fails closed at capacity, and reuses capacity only after terminal cleanup makes callbacks stale', () => {
    vi.useFakeTimers();
    const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });runtimes.push(runtime);
    let sequence = 0;
    for (let n = 0; n < SESSION_PRESENTATION_MAX_SESSIONS; n++) {
      const sessionID = 'session-' + n;
      runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } });
      expect(runtime.updateSessionPresentation(presentation({ sessionID, sequence: ++sequence }))).toBe(true);
      expect(runtime.updateSessionPresentation(presentation({ sessionID, sequence: ++sequence, phase: 'cleared' }))).toBe(true);
    }
    runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'session-overflow', status: { type: 'busy' } } });
    expect(runtime.updateSessionPresentation(presentation({ sessionID: 'session-overflow', sequence: ++sequence }))).toBe(false);
    vi.advanceTimersByTime(26 * 60 * 60 * 1000);
    runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'session-next', status: { type: 'busy' } } });
    expect(runtime.updateSessionPresentation(presentation({ sessionID: 'session-next', sequence: ++sequence }))).toBe(true);
    expect(runtime.updateSessionPresentation(presentation({ sessionID: 'session-0', sequence: 1 }))).toBe(false);
    for (let n = 0; n < SESSION_PRESENTATION_MAX_OWNERS; n++) runtime.clearSessionPresentationOwner('retired-' + n);
    expect(runtime.updateSessionPresentation(presentation({ sessionID: 'session-next', ownerID: 'retired-0', sequence: ++sequence }))).toBe(false);
    expect(runtime.updateSessionPresentation(presentation({ sessionID: 'session-next', ownerID: 'new-overflow-owner', sequence: ++sequence }))).toBe(false);
  });

  it('captures Stop presentation identity across actual progress without clearing a newer generation', () => {
    const { runtime } = presentationRuntime();runtime.updateSessionPresentation(presentation());
    const acknowledged = runtime.captureSessionPresentationClear('session-presentation');
    runtime.updateSessionPresentation(presentation({ sequence: 2, progress: 1 }));
    expect(acknowledged()).toBe(true);expect(runtime.getSessionActivitySnapshot()['session-presentation'].presentation).toBeNull();
    runtime.updateSessionPresentation(presentation({ sequence: 3, generation: 'generation-A' }));
    const oldAcknowledgment = runtime.captureSessionPresentationClear('session-presentation');
    runtime.updateSessionPresentation(presentation({ sequence: 4, generation: 'generation-B', objectiveID: 'msg-new', assistantID: 'msg-new-assistant', stepID: 'step-new', attemptID: 'trace:new' }));
    expect(oldAcknowledgment()).toBe(false);expect(runtime.getSessionActivitySnapshot()['session-presentation'].presentation.generation).toBe('generation-B');
  });
  it('capture alone cannot clear on failed responses or adopt a phase absent at Stop request entry', () => {
    const { runtime } = presentationRuntime(), absent = runtime.captureSessionPresentationClear('session-presentation');
    runtime.updateSessionPresentation(presentation());expect(absent()).toBe(false);
    const failedResponseClear = runtime.captureSessionPresentationClear('session-presentation');
    const response = { statusCode: 409 };
    if (response.statusCode >= 200 && response.statusCode < 300) failedResponseClear();
    expect(runtime.getSessionActivitySnapshot()['session-presentation'].presentation.phase).toBe('finalizing');
  });
  it('throwing optional presentation observers cannot veto begin, clear or authoritative idle', () => {
    const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent: event => {
      if (event.type === 'openchamber:session-activity' && event.properties.phase === 'busy' && event.properties.presentationRevision) throw Error('display observer failed');
    } });runtimes.push(runtime);
    runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'session-presentation', status: { type: 'busy' } } });
    expect(() => runtime.updateSessionPresentation(presentation())).not.toThrow();
    const clear = runtime.captureSessionPresentationClear('session-presentation');expect(() => clear()).not.toThrow();
    runtime.updateSessionPresentation(presentation({ sequence: 2, generation: 'generation-next' }));
    expect(() => runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'session-presentation', status: { type: 'idle' } } })).not.toThrow();
    expect(runtime.getSessionState('session-presentation').status).toBe('idle');expect(runtime.getSessionActivitySnapshot()['session-presentation'].presentation).toBeNull();
  });

});
