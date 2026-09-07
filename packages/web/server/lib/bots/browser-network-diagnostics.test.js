import { describe, expect, it, vi } from 'vitest';
import { publicBotComputerBrowserStatus } from './browser-service.js';
import { createBrowserNetworkJournal } from './browser-network-diagnostics.js';

const STREAM = '00000000-0000-4000-8000-000000000001';
const NOW = 1_000_000;
const response = (sequence, overrides = {}) => ({ sequence, observedAt: NOW,
  generation: 1, kind: 'response', origin: 'https://app.hubspot.com',
  path: '/api', requestType: 'Fetch', statusCode: 401, ...overrides });
const project = (entries, streamId = STREAM) => publicBotComputerBrowserStatus({
  recentNetworkTrail: { streamId, entries },
}, { now: NOW }).recentNetworkTrail;

describe('browser network status boundary', () => {
  it('keeps older images compatible and rejects malformed stream identities', () => {
    expect(publicBotComputerBrowserStatus({})).not.toHaveProperty('recentNetworkTrail');
    expect(project([], 'secret')).toBeUndefined();
  });

  it('strips unreviewed fields and masks paths before renderer or journal access', () => {
    const trail = project([response(1, { path: '/api/12345678',
      origin: 'https://app.hubspot.com/private?token=secret',
      headers: { cookie: 'secret' }, body: 'secret', cookie: 'secret', console: 'secret',
    }), response(2, { path: '/api?token=secret' }), response(3, { origin: 'https://user:secret@example.com' })]);
    expect(trail.entries).toEqual([response(1, { path: '/api/*' })]);
    expect(JSON.stringify(trail)).not.toContain('secret');
  });

  it('bounds data, expires old entries, and rejects duplicate or out-of-order sequences', () => {
    expect(project([response(1), response(1), response(0), response(2, { observedAt: NOW - 300_000 }),
      response(3, { observedAt: NOW + 6000 }), response(4, { kind: 'arbitrary' }), response(5)]).entries)
      .toEqual([response(1), response(5)]);
    expect(project(Array.from({ length: 150 }, (_, index) => response(index + 1))).entries).toHaveLength(100);
    const host = Array(4).fill('a'.repeat(62)).join('.');
    const trail = project(Array.from({ length: 100 }, (_, index) => response(index + 1, {
      kind: 'cookie_block', origin: `https://${host}`, path: `/${'a/'.repeat(99)}`,
      reason: 'A'.repeat(128),
    })));
    expect(trail.entries.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(trail))).toBeLessThanOrEqual(64 * 1024);
  });

  it('retains only bounded lifecycle and proxy failure details', () => {
    const trail = project([
      response(1, { kind: 'lifecycle', reason: 'browser_closed', failureCode: 'DEVRYAN_BOT_NAVIGATION_FAILED' }),
      response(2, { kind: 'lifecycle', reason: 'unreviewed' }),
      response(3, { kind: 'proxy_failure', reason: 'ECONNRESET', statusCode: 502 }),
    ]);
    expect(trail.entries).toEqual([
      { sequence: 1, observedAt: NOW, generation: 1, kind: 'lifecycle', reason: 'browser_closed',
        failureCode: 'DEVRYAN_BOT_NAVIGATION_FAILED' },
      { sequence: 3, observedAt: NOW, generation: 1, kind: 'proxy_failure', reason: 'ECONNRESET',
        statusCode: 502, origin: 'https://app.hubspot.com' },
    ]);
  });
});

describe('browser network journal', () => {
  it('journals each sequence once, accepts a restarted stream, and reports retention gaps', () => {
    const recordDiagnostic = vi.fn();
    const journal = createBrowserNetworkJournal({ recordDiagnostic, now: () => NOW });
    journal.observe('bot', project([response(1), response(2)]));
    journal.observe('bot', project([response(1), response(2)]));
    journal.observe('bot', project([response(4)]));
    journal.observe('bot', project([response(1)], '00000000-0000-4000-8000-000000000002'));
    expect(recordDiagnostic.mock.calls.map(([record]) => record.type))
      .toEqual(['connection', 'connection', 'gap', 'connection', 'connection']);
    expect(recordDiagnostic.mock.calls[2][0].payload).toMatchObject({ firstMissingSequence: 3, lastMissingSequence: 3 });
  });

  it('does not consume an entry if journal submission throws', () => {
    const recordDiagnostic = vi.fn().mockImplementationOnce(() => { throw new Error('journal unavailable'); });
    const journal = createBrowserNetworkJournal({ recordDiagnostic, now: () => NOW });
    const trail = project([response(1)]);
    expect(() => journal.observe('bot', trail)).toThrow('journal unavailable');
    journal.observe('bot', trail);
    journal.observe('bot', trail);
    expect(recordDiagnostic).toHaveBeenCalledTimes(2);
  });
});
