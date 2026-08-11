import { describe, expect, it } from 'vitest';

import { createDiagnosticRecoveryTracker } from './diagnostic-recovery.js';

const toolCompleted = (sessionId = 'ses_1') => ({
  type: 'message.part.updated',
  properties: {
    part: { type: 'tool', sessionID: sessionId, state: { status: 'completed' } },
  },
});

const sessionStatus = (type, sessionId = 'ses_1') => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type } },
});

describe('diagnostic recovery correlation', () => {
  it('marks a failure recovered only after successful continuation followed by idle', () => {
    const tracker = createDiagnosticRecoveryTracker();
    tracker.trackFailure({ sessionId: 'ses_1', eventId: 'event_1' });
    expect(tracker.observe(toolCompleted())).toEqual([]);
    expect(tracker.observe(sessionStatus('idle'))).toEqual([
      { sessionId: 'ses_1', eventId: 'event_1', outcome: 'recovered' },
    ]);
    expect(tracker.observe(sessionStatus('idle'))).toEqual([]);
  });

  it('leaves an idle failure unknown when no successful continuation was observed', () => {
    const tracker = createDiagnosticRecoveryTracker();
    tracker.trackFailure({ sessionId: 'ses_1', eventId: 'event_1' });
    expect(tracker.observe(sessionStatus('idle'))).toEqual([]);
    expect(tracker.getPendingCount()).toBe(0);
    expect(tracker.observe(toolCompleted())).toEqual([]);
  });

  it('settles every pending failure unresolved on terminal session evidence exactly once', () => {
    const tracker = createDiagnosticRecoveryTracker();
    tracker.trackFailure({ sessionId: 'ses_1', eventId: 'event_1' });
    tracker.trackFailure({ sessionId: 'ses_1', eventId: 'event_2' });
    expect(tracker.observe({ type: 'session.error', properties: { sessionID: 'ses_1' } }))
      .toEqual([
        { sessionId: 'ses_1', eventId: 'event_1', outcome: 'unresolved' },
        { sessionId: 'ses_1', eventId: 'event_2', outcome: 'unresolved' },
      ]);
    expect(tracker.markUnresolved('ses_1')).toEqual([]);
  });

  it('does not retain pending state across a process restart', () => {
    const beforeRestart = createDiagnosticRecoveryTracker();
    beforeRestart.trackFailure({ sessionId: 'ses_1', eventId: 'event_1' });
    const afterRestart = createDiagnosticRecoveryTracker();
    expect(afterRestart.observe(toolCompleted())).toEqual([]);
    expect(afterRestart.observe(sessionStatus('idle'))).toEqual([]);
  });
});
