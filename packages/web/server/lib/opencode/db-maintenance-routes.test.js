import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';

import { registerOpenCodeDbMaintenanceRoutes } from './db-maintenance-routes.js';

const V2_INSPECTION = {
  dbPath: '/tmp/bundle/opencode/opencode.db',
  dbSource: 'selection',
  runtimeGeneration: 2,
  generation: 2,
  schema: 'unknown',
  eventRows: 0,
  orphanEventRows: 0,
  reclaimableBytes: 0,
  error: 'v2_database',
};

const createApp = ({ inspection = {}, ...overrides } = {}) => {
  const maintenance = {
    inspect: vi.fn(async () => ({
      dbPath: '/tmp/opencode.db',
      exists: true,
      generation: 1,
      schema: 'ok',
      dbBytes: 15_000,
      walBytes: 100,
      reclaimableBytes: 4_096,
      eventRows: 120,
      orphanEventRows: 20,
      lastRun: null,
      lastDryRun: null,
      running: false,
      ...inspection,
    })),
    run: vi.fn(async (options) => ({ ...options, status: 'ok', deletedEvents: 0, orphanEvents: 20, prunableEvents: 36 })),
  };
  const app = express();
  registerOpenCodeDbMaintenanceRoutes(app, {
    maintenance,
    readMaintenanceSettings: async () => ({ idleHours: 48, keepSeqPerAggregate: 32 }),
    ...overrides,
  });
  return { app, maintenance };
};

describe('OpenCode db maintenance routes', () => {
  it('GET /api/storage/opencode-db merges inspection and settings', async () => {
    const { app } = createApp();

    const response = await request(app).get('/api/storage/opencode-db');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      dbBytes: 15_000,
      eventRows: 120,
      orphanEventRows: 20,
      maintenance: { enabled: true, idleHours: 48, keepSeqPerAggregate: 32 },
    });
    expect(response.body).not.toHaveProperty('compactionPending');
    expect(response.body).not.toHaveProperty('managedRuntime');
  });

  it('POST compact with dryRun runs a read-only pass with the configured settings', async () => {
    const { app, maintenance } = createApp();

    const response = await request(app)
      .post('/api/storage/opencode-db/compact')
      .set('Content-Type', 'application/json')
      .send({ dryRun: true });

    expect(response.status).toBe(200);
    expect(response.body.dryRun).toBe(true);
    expect(response.body.run).toMatchObject({ dryRun: true, reason: 'dry_run', vacuum: 'force', idleHours: 48, keepSeqPerAggregate: 32 });
    expect(maintenance.run).toHaveBeenCalledTimes(1);
    expect(maintenance.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, vacuum: 'force' }));
  });

  it('GET reports a native v2 database as such', async () => {
    const { app } = createApp({ inspection: V2_INSPECTION });

    const response = await request(app).get('/api/storage/opencode-db');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...V2_INSPECTION, exists: true });
  });

  it('POST compact without dryRun is refused for every database and never runs a pass', async () => {
    // Even a positively v1 database: mutations need an OpenCode 1 runtime,
    // which runtime selection never records.
    const unknownLayout = { generation: 'unknown', schema: 'mismatch', error: 'schema_mismatch: session_context_epoch' };
    for (const inspection of [{}, V2_INSPECTION, unknownLayout]) {
      for (const body of [{}, { dryRun: false }, { dryRun: 'true' }]) {
        const { app, maintenance } = createApp({ inspection });

        const response = await request(app)
          .post('/api/storage/opencode-db/compact')
          .set('Content-Type', 'application/json')
          .send(body);

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('maintenance_not_applicable');
        expect(maintenance.run).not.toHaveBeenCalled();
      }
    }
  });

  it('POST compact with dryRun still answers for a native v2 database', async () => {
    const { app, maintenance } = createApp({ inspection: V2_INSPECTION });

    const response = await request(app)
      .post('/api/storage/opencode-db/compact')
      .set('Content-Type', 'application/json')
      .send({ dryRun: true });

    expect(response.status).toBe(200);
    expect(response.body.dryRun).toBe(true);
    expect(maintenance.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('reports inspection failures as 500 with the message', async () => {
    const { app } = createApp({
      maintenance: { inspect: vi.fn(async () => { throw new Error('locked'); }), run: vi.fn() },
    });

    const response = await request(app).get('/api/storage/opencode-db');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('locked');
  });
});
