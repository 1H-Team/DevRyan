import { describe, expect, test } from 'vitest';

import { normalizeClearRange, registerDiagnosticsRoutes } from './routes.js';

describe('diagnostics clear ranges', () => {
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

  test('exposes the current context-mode recovery incident in status', async () => {
    let statusHandler;
    const app = {
      get(_path, handler) {
        statusHandler = handler;
      },
      post() {},
      delete() {},
    };
    const contextModeRecovery = {
      state: 'draining',
      detectedAt: '2026-08-15T12:33:19.000Z',
      occurrenceCount: 3,
      lastRestartError: null,
    };
    registerDiagnosticsRoutes(app, {
      runtime: {
        async getStatus() {
          return { enabled: true, sessionCount: 2 };
        },
      },
      getContextModeRecoveryStatus: () => contextModeRecovery,
      getCommandDeadlineRecoveryStatus: () => null,
    });
    const response = {
      json(payload) {
        this.payload = payload;
        return this;
      },
    };

    await statusHandler({}, response);

    expect(response.payload).toEqual({
      enabled: true,
      sessionCount: 2,
      contextModeRecovery,
      commandDeadlineRecovery: null,
    });
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
    registerDiagnosticsRoutes(app, {
      runtime: { async getStatus() { return { enabled: true, sessionCount: 1 }; } },
      getCommandDeadlineRecoveryStatus: () => commandDeadlineRecovery,
    });
    const response = { json(payload) { this.payload = payload; return this; } };

    await statusHandler({}, response);

    expect(response.payload).toMatchObject({ commandDeadlineRecovery });
  });
});
