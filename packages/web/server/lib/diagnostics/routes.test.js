import { describe, expect, test } from 'vitest';

import { createEventLoopDelaySampler, normalizeClearRange, registerDiagnosticsRoutes } from './routes.js';

describe('diagnostics clear ranges', () => {
  test('exports a bounded Chrome Trace through the existing scoped export route after flushing', async () => {
    let exportHandler;
    const order = [];
    const app = { get() {}, delete() {}, post(path, handler) { if (path === '/api/diagnostics/export') exportHandler = handler; } };
    registerDiagnosticsRoutes(app, { runtime: {
      journal: { async flush() { order.push('flush'); }, async readRecords() { order.push('read'); return [
        { type: 'lifecycle', event: 'objective_state', at: 20, sessionID: 'ses_root', directory: '/repo',
          payload: { messageID: 'msg_root', state: 'completed', createdAt: 10 } },
        { type: 'lifecycle', event: 'objective_state', at: 20, sessionID: 'ses_other', directory: '/other',
          payload: { messageID: 'msg_other', state: 'completed', createdAt: 10 } },
      ]; } }, async getWorktreeReceipts() { return []; },
    } });
    const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
    await exportHandler({ body: { scope: 'task', sessionID: 'ses_root', directory: '/repo', format: 'chrome-trace' } }, response);
    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Disposition']).toContain('DevRyan-trace.json');
    expect(order[0]).toBe('flush');
    expect(response.payload.metadata.roots.map((root) => root.rootSessionId)).toEqual(['ses_root']);
    expect(JSON.stringify(response.payload)).not.toContain('ses_other');
    await exportHandler({ body: { format: 'unbounded' } }, response);
    expect(response.statusCode).toBe(400);
  });

  test('normalizes supported ranges to an inclusive cutoff', () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    expect(normalizeClearRange('24h', now)).toEqual({
      since: now - (24 * 60 * 60 * 1000),
    });
    expect(normalizeClearRange('7d', now)).toEqual({
      since: now - (7 * 24 * 60 * 60 * 1000),
    });
    expect(normalizeClearRange('14d', now)).toEqual({
      since: now - (14 * 24 * 60 * 60 * 1000),
    });
    expect(normalizeClearRange('all', now)).toEqual({});
    expect(() => normalizeClearRange('30d', now)).toThrow('24h, 7d, 14d, or all');
    expect(() => normalizeClearRange(['24h', 'all'], now)).toThrow('24h, 7d, 14d, or all');
  });

  test('passes the selected cutoff to the journal', async () => {
    let deleteHandler;
    let receivedOptions;
    const app = {
      get() {},
      post() {},
      delete(_path, handler) {
        deleteHandler = handler;
      },
    };
    const status = { enabled: true, sessionCount: 1 };
    registerDiagnosticsRoutes(app, {
      now: () => 1_000_000_000,
      runtime: {
        journal: {
          async clear(options) {
            receivedOptions = options;
            return status;
          },
        },
      },
    });
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };

    await deleteHandler({ query: { range: '24h' } }, response);

    expect(receivedOptions).toEqual({ since: 1_000_000_000 - (24 * 60 * 60 * 1000) });
    expect(response.payload).toBe(status);
  });

  test('exposes command deadline recovery status', async () => {
    let statusHandler;
    const app = {
      get(_path, handler) { statusHandler = handler; },
      post() {},
      delete() {},
    };
    const commandDeadlineRecovery = {
      activeCount: 1,
      recoveredCount: 2,
      unresolvedCount: 1,
      lastOutcome: 'unresolved',
      lastError: 'Other sessions are active',
      updatedAt: 123,
    };
    const eventLoop = { windowMs: 1000, p50Ms: 10.5, p99Ms: 40, maxMs: 52.25 };
    const ledgerWorker = { running: true, pendingCalls: 0, heapUsedMB: 120, heapTotalMB: 160 };
    registerDiagnosticsRoutes(app, {
      runtime: { async getStatus() { return { enabled: true, sessionCount: 1 }; } },
      getCommandDeadlineRecoveryStatus: () => commandDeadlineRecovery,
      eventLoopSampler: { read: () => eventLoop },
      getLedgerWorkerStatus: async () => ledgerWorker,
    });
    const response = { json(payload) { this.payload = payload; return this; } };

    await statusHandler({}, response);

    expect(response.payload).toEqual({ enabled: true, sessionCount: 1, commandDeadlineRecovery, eventLoop, ledgerWorker });
  });
});

describe('event-loop delay sampler', () => {
  test('reports milliseconds since the previous read and starts a new window', () => {
    let at = 1_000;
    const calls = [];
    const histogram = {
      enable: () => calls.push('enable'),
      disable: () => calls.push('disable'),
      reset: () => calls.push('reset'),
      percentile: (p) => (p === 50 ? 12_345_678 : 48_000_000),
      max: 61_234_567,
    };
    const sampler = createEventLoopDelaySampler({ now: () => at, monitor: () => histogram });
    at = 31_000;
    expect(sampler.read()).toEqual({ windowMs: 30_000, p50Ms: 12.35, p99Ms: 48, maxMs: 61.23 });
    at = 32_000;
    expect(sampler.read().windowMs).toBe(1_000);
    sampler.stop();
    expect(calls).toEqual(['enable', 'reset', 'reset', 'disable']);
  });

  test('reports zero for an empty histogram', () => {
    const histogram = { enable() {}, disable() {}, reset() {}, percentile: () => Number.NaN, max: 0 };
    const sampler = createEventLoopDelaySampler({ now: () => 0, monitor: () => histogram });
    expect(sampler.read()).toEqual({ windowMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });
});
