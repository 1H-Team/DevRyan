import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';

import { createOpenCodeDbCompactionScheduler } from './db-maintenance.js';
import { registerOpenCodeDbMaintenanceRoutes } from './db-maintenance-routes.js';

const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

const createApp = (overrides = {}) => {
  const maintenance = {
    inspect: vi.fn(async () => ({
      dbPath: '/tmp/opencode.db',
      exists: true,
      schema: 'ok',
      dbBytes: 15_000,
      walBytes: 100,
      reclaimableBytes: 4_096,
      eventRows: 120,
      orphanEventRows: 20,
      lastRun: null,
      lastDryRun: null,
      running: false,
    })),
    run: vi.fn(async (options) => ({ ...options, status: 'ok', deletedEvents: 0, orphanEvents: 20, prunableEvents: 36 })),
  };
  const scheduler = createOpenCodeDbCompactionScheduler();
  const restartOpenCode = vi.fn(async () => {});
  let managed = true;
  const app = express();
  registerOpenCodeDbMaintenanceRoutes(app, {
    maintenance,
    scheduler,
    restartOpenCode,
    isManagedRuntime: () => managed,
    readMaintenanceSettings: async () => ({ idleHours: 48, keepSeqPerAggregate: 32 }),
    logger: { warn: vi.fn() },
    ...overrides,
  });
  const server = app.listen(0);
  servers.push(server);
  return {
    server,
    maintenance,
    scheduler,
    restartOpenCode,
    setManaged: (value) => { managed = value; },
  };
};

describe('OpenCode db maintenance routes', () => {
  it('GET /api/storage/opencode-db merges inspection, settings and runtime flags', async () => {
    const { server } = createApp();

    const response = await request(server).get('/api/storage/opencode-db');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      dbBytes: 15_000,
      eventRows: 120,
      orphanEventRows: 20,
      maintenance: { enabled: true, idleHours: 48, keepSeqPerAggregate: 32 },
      managedRuntime: true,
      compactionPending: false,
    });
  });

  it('POST compact with dryRun runs a read-only pass with the configured settings and never restarts', async () => {
    const { server, maintenance, restartOpenCode, scheduler } = createApp();

    const response = await request(server)
      .post('/api/storage/opencode-db/compact')
      .set('Content-Type', 'application/json')
      .send({ dryRun: true });

    expect(response.status).toBe(200);
    expect(response.body.dryRun).toBe(true);
    expect(response.body.run).toMatchObject({ dryRun: true, reason: 'dry_run', vacuum: 'force', idleHours: 48, keepSeqPerAggregate: 32 });
    expect(maintenance.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, vacuum: 'force' }));
    expect(restartOpenCode).not.toHaveBeenCalled();
    expect(scheduler.isForcedPending()).toBe(false);
  });

  it('POST compact schedules a one-shot forced run and restarts OpenCode', async () => {
    const { server, maintenance, restartOpenCode, scheduler } = createApp();

    const response = await request(server)
      .post('/api/storage/opencode-db/compact')
      .set('Content-Type', 'application/json')
      .send({});

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ scheduled: true });
    expect(scheduler.isForcedPending()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(restartOpenCode).toHaveBeenCalledTimes(1);
    // The route never runs maintenance itself; the pre-launch hook consumes the flag.
    expect(maintenance.run).not.toHaveBeenCalled();

    const again = await request(server)
      .post('/api/storage/opencode-db/compact')
      .set('Content-Type', 'application/json')
      .send({});
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ scheduled: true, pending: true });
    expect(restartOpenCode).toHaveBeenCalledTimes(1);
  });

  it('POST compact refuses for an external OpenCode runtime', async () => {
    const { server, restartOpenCode, scheduler, setManaged } = createApp();
    setManaged(false);

    const response = await request(server)
      .post('/api/storage/opencode-db/compact')
      .set('Content-Type', 'application/json')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('external_runtime');
    expect(scheduler.isForcedPending()).toBe(false);
    expect(restartOpenCode).not.toHaveBeenCalled();
  });

  it('reports inspection failures as 500 with the message', async () => {
    const { server } = createApp({
      maintenance: { inspect: vi.fn(async () => { throw new Error('locked'); }), run: vi.fn() },
    });

    const response = await request(server).get('/api/storage/opencode-db');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('locked');
  });
});
