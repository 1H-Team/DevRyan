import { describe, expect, test } from 'bun:test';
import { resolveSessionDeleteFailureDescription } from './sessionDeleteFeedback';

describe('resolveSessionDeleteFailureDescription', () => {
  test('returns the one shared actionable failure reason', () => {
    expect(resolveSessionDeleteFailureDescription([
      { sessionId: 'session-a', status: 503, message: 'OpenCode is restarting' },
      { sessionId: 'session-b', status: 503, message: 'OpenCode is restarting' },
    ], 'Please try again in a moment.')).toBe('OpenCode is restarting');
  });

  test('uses the fallback for mixed or unavailable failure reasons', () => {
    expect(resolveSessionDeleteFailureDescription([
      { sessionId: 'session-a', message: 'First failure' },
      { sessionId: 'session-b', message: 'Second failure' },
    ], 'Please try again in a moment.')).toBe('Please try again in a moment.');

    expect(resolveSessionDeleteFailureDescription([
      { sessionId: 'session-a', message: 'Unknown error' },
    ], 'Please try again in a moment.')).toBe('Please try again in a moment.');
  });
});
