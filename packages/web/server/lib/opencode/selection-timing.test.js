import { test, expect, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { selectionIngress, markSelectionTiming } from './selection-timing.js';
import { createSessionActivityGate } from './session-activity-gate.js';
import { registerSessionRetentionRoutes } from './session-retention.js';

test('selection diagnostics bound middleware/gate timings without recording content or credentials', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const app = express();
  app.use(selectionIngress);
  app.use((_req, _res, next) => setTimeout(next, 20));
  app.use((req, _res, next) => { markSelectionTiming(req, 'authenticatedMs'); next(); });
  registerSessionRetentionRoutes(app, { gate: createSessionActivityGate(), retention: { run: async () => ({}) } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/openchamber/session-retention/selection`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-devryan-selection-request': 'fixture_request', authorization: 'fixture-private' },
      body: JSON.stringify({ clientID: 'fixture_client', sessionID: 'ses_private', revision: 7, content: 'fixture-conversation' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-devryan-selection-request')).toBe('fixture_request');
    const records = log.mock.calls.map(args => JSON.parse(args[1]));
    expect(records[0]).toMatchObject({ requestID: 'fixture_request', phase: 'ingress' });
    expect(records[1]).toMatchObject({ requestID: 'fixture_request', phase: 'finished', revision: 7, status: 200 });
    expect(records[1].authenticatedMs).toBeGreaterThanOrEqual(15);
    expect(records[1].gateEndMs).toBeGreaterThanOrEqual(records[1].gateStartMs);
    expect(JSON.stringify(records)).not.toMatch(/private|conversation|fixture_client/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); log.mockRestore(); }
});
