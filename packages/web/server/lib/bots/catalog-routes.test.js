import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { registerBotCatalogRoutes } from './catalog-routes.js';

const OWNER = Object.freeze({ id: 'owner-1', scope: 'bot-owner', botOwner: true, role: 'admin' });
const BACKUP_ID = 'b0000000-0000-4000-8000-000000000001';

const createMaintenance = () => ({
  status: vi.fn(() => ({ latest: { id: BACKUP_ID }, count: 1 })),
  listBackups: vi.fn(async () => [{ id: BACKUP_ID, kind: 'manual' }]),
  backupNow: vi.fn(async (options) => ({ id: BACKUP_ID, ...options })),
  restore: vi.fn(async (options) => ({ restored: true, options })),
  startEmpty: vi.fn(async (options) => ({ started: true, options })),
  resumeActivation: vi.fn(async () => ({ resumed: true })),
});

const createCatalogImport = () => ({
  status: vi.fn(() => ({ cloud: { hasBots: true }, import: null, pending: true })),
  start: vi.fn(async ({ mode, writersStopped }) => ({ started: true, mode, writersStopped })),
  cancel: vi.fn(async () => ({ cancelled: true })),
  dismiss: vi.fn(async () => ({ dismissed: true })),
  probeCloud: vi.fn(async () => ({ cloud: { hasBots: true, code: null }, checking: false, import: null, pending: true })),
});

const createApp = (options = {}) => {
  const {
    getStatus = vi.fn(async () => ({ state: 'ready', code: null })),
    maintenance = createMaintenance(),
    catalogImport = createCatalogImport(),
  } = options;
  // An explicit `principal: undefined` means "no principal", not the owner.
  const principal = Object.hasOwn(options, 'principal') ? options.principal : OWNER;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (principal !== undefined) req.principal = principal;
    next();
  });
  registerBotCatalogRoutes(app, { getStatus, maintenance, catalogImport });
  return { app, getStatus, maintenance, catalogImport };
};

const OWNER_ONLY_ROUTES = Object.freeze([
  ['get', '/api/bots/database/backups'],
  ['post', '/api/bots/database/backups'],
  ['post', '/api/bots/database/restore'],
  ['post', '/api/bots/database/start-empty'],
  ['post', '/api/bots/database/activation/resume'],
  ['get', '/api/bots/database/import'],
  ['post', '/api/bots/database/import'],
  ['post', '/api/bots/database/import/check'],
  ['post', '/api/bots/database/import/cancel'],
  ['post', '/api/bots/database/import/dismiss'],
]);

const NON_OWNERS = Object.freeze([
  ['no principal', undefined],
  ['null principal', null],
  ['managed admin', { id: 'admin-1', scope: 'managed', role: 'admin' }],
  ['owner scope without flag', { id: 'x', scope: 'bot-owner' }],
  ['owner scope with truthy non-boolean flag', { id: 'x', scope: 'bot-owner', botOwner: 'true' }],
  ['owner flag with another scope', { id: 'x', scope: 'managed', botOwner: true }],
]);

const send = (app, method, route, body) => {
  const pending = request(app)[method](route);
  return body === undefined ? pending : pending.send(body);
};

const allFakeCalls = (maintenance, catalogImport) => [
  ...Object.values(maintenance),
  ...Object.values(catalogImport),
].reduce((sum, fn) => sum + fn.mock.calls.length, 0);

describe('Bot catalog routes', () => {
  it('requires a status provider', () => {
    expect(() => registerBotCatalogRoutes(express(), {})).toThrow(TypeError);
    expect(() => registerBotCatalogRoutes(express())).toThrow(TypeError);
  });

  it('reports status to non-owners without backups or import details', async () => {
    for (const [, principal] of NON_OWNERS) {
      const { app, getStatus, maintenance, catalogImport } = createApp({ principal });
      const response = await request(app).get('/api/bots/database');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ state: 'ready', code: null, viewerIsOwner: false });
      expect(getStatus).toHaveBeenCalledWith({ owner: false });
      expect(maintenance.status).not.toHaveBeenCalled();
      expect(catalogImport.status).not.toHaveBeenCalled();
    }
  });

  it('adds backups and import status for the workstation owner', async () => {
    const { app, getStatus } = createApp();
    const response = await request(app).get('/api/bots/database');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      state: 'ready',
      code: null,
      viewerIsOwner: true,
      backups: { latest: { id: BACKUP_ID }, count: 1 },
      import: { cloud: { hasBots: true }, import: null, pending: true },
    });
    expect(getStatus).toHaveBeenCalledWith({ owner: true });
  });

  it('omits unavailable owner sections and never lets status override the viewer flag', async () => {
    const { app } = createApp({
      getStatus: async () => ({ state: 'unavailable', viewerIsOwner: true }),
      maintenance: null,
      catalogImport: null,
    });
    const owner = await request(app).get('/api/bots/database');
    expect(owner.body).toEqual({ state: 'unavailable', viewerIsOwner: true });

    const { app: guestApp } = createApp({
      principal: null,
      getStatus: async () => ({ state: 'ready', viewerIsOwner: true }),
    });
    const guest = await request(guestApp).get('/api/bots/database');
    expect(guest.body.viewerIsOwner).toBe(false);
  });

  it('maps a failing status provider through the error envelope', async () => {
    const { app } = createApp({
      getStatus: async () => { throw Object.assign(new Error('catalog down'), { code: 'bot_database_unavailable' }); },
    });
    const response = await request(app).get('/api/bots/database');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'catalog down', code: 'bot_database_unavailable', retryable: false });
  });

  it('refuses every owner-only route to anyone but the workstation owner', async () => {
    for (const [label, principal] of NON_OWNERS) {
      const { app, maintenance, catalogImport } = createApp({ principal });
      for (const [method, route] of OWNER_ONLY_ROUTES) {
        const response = await send(app, method, route, method === 'post'
          ? { backupId: BACKUP_ID, confirmation: 'RESTORE', mode: 'merge', writersStopped: true }
          : undefined);
        expect({ label, route, method, status: response.status, body: response.body }).toEqual({
          label,
          route,
          method,
          status: 403,
          body: { error: 'Only this computer\'s owner can change the local Bot catalog', code: 'bot_catalog_owner_required' },
        });
      }
      expect(allFakeCalls(maintenance, catalogImport)).toBe(0);
    }
  });

  it('lists and creates backups for the owner without accepting a caller-chosen kind', async () => {
    const { app, maintenance } = createApp();
    const listed = await request(app).get('/api/bots/database/backups');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ backups: [{ id: BACKUP_ID, kind: 'manual' }] });

    const created = await request(app).post('/api/bots/database/backups').send({ kind: 'pre_import', extra: true });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ backup: { id: BACKUP_ID, kind: 'manual' } });
    expect(maintenance.backupNow).toHaveBeenCalledTimes(1);
    expect(maintenance.backupNow).toHaveBeenCalledWith({ kind: 'manual' });
  });

  it('passes only the restore and start-empty fields through', async () => {
    const { app, maintenance } = createApp();
    const restored = await request(app).post('/api/bots/database/restore').send({
      backupId: BACKUP_ID, confirmation: 'RESTORE', force: true, path: '/etc/passwd',
    });
    expect(restored.status).toBe(200);
    expect(maintenance.restore).toHaveBeenCalledWith({ backupId: BACKUP_ID, confirmation: 'RESTORE' });
    expect(restored.body).toEqual({ restored: true, options: { backupId: BACKUP_ID, confirmation: 'RESTORE' } });

    const emptied = await request(app).post('/api/bots/database/start-empty').send({
      confirmation: 'START EMPTY', backupId: BACKUP_ID,
    });
    expect(emptied.status).toBe(200);
    expect(maintenance.startEmpty).toHaveBeenCalledWith({ confirmation: 'START EMPTY' });

    // A missing body still reaches the owner-checked operation with empty fields.
    await request(app).post('/api/bots/database/restore');
    expect(maintenance.restore).toHaveBeenLastCalledWith({ backupId: undefined, confirmation: undefined });
    await request(app).post('/api/bots/database/start-empty');
    expect(maintenance.startEmpty).toHaveBeenLastCalledWith({ confirmation: undefined });
  });

  it('resumes activation for the owner', async () => {
    const { app, maintenance } = createApp();
    const response = await request(app).post('/api/bots/database/activation/resume').send({ reason: 'ignored' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ resumed: true });
    expect(maintenance.resumeActivation).toHaveBeenCalledTimes(1);
    expect(maintenance.resumeActivation).toHaveBeenCalledWith();
  });

  it('reports recovery routes as unavailable without a maintenance service', async () => {
    const { app } = createApp({ maintenance: null });
    for (const [method, route] of [
      ['get', '/api/bots/database/backups'],
      ['post', '/api/bots/database/backups'],
      ['post', '/api/bots/database/restore'],
      ['post', '/api/bots/database/start-empty'],
      ['post', '/api/bots/database/activation/resume'],
    ]) {
      const response = await send(app, method, route, method === 'post' ? {} : undefined);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'bot_backup_unavailable', retryable: false });
    }
  });

  it('starts an import with the mode and only a literal writersStopped confirmation', async () => {
    const { app, catalogImport } = createApp();
    const started = await request(app).post('/api/bots/database/import').send({
      mode: 'merge', writersStopped: true, url: 'https://evil.example', secretKey: 'x',
    });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ started: true, mode: 'merge', writersStopped: true });
    const [call] = catalogImport.start.mock.calls[0];
    expect(Object.keys(call).sort()).toEqual(['mode', 'principal', 'request', 'writersStopped']);
    expect(call).toMatchObject({ mode: 'merge', writersStopped: true, principal: OWNER });
    expect(call.request.path).toBe('/api/bots/database/import');
    await request(app).post('/api/bots/database/import').send({ mode: 'merge', scope: 'configuration', writersStopped: true });
    expect(catalogImport.start.mock.lastCall[0]).toMatchObject({ scope: 'configuration', mode: 'merge', writersStopped: true });

    for (const writersStopped of ['true', 1, 'yes', {}, null]) {
      await request(app).post('/api/bots/database/import').send({ mode: 'empty', writersStopped });
      expect(catalogImport.start.mock.lastCall[0]).toMatchObject({ mode: 'empty', writersStopped: false });
    }
    await request(app).post('/api/bots/database/import');
    expect(catalogImport.start.mock.lastCall[0]).toMatchObject({ mode: undefined, writersStopped: false });
  });

  it('serves import status, cancel and dismiss for the owner', async () => {
    const { app, catalogImport } = createApp();
    const status = await request(app).get('/api/bots/database/import');
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toEqual({ cloud: { hasBots: true }, import: null, pending: true });

    const cancelled = await request(app).post('/api/bots/database/import/cancel').send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true });
    const dismissed = await request(app).post('/api/bots/database/import/dismiss').send({});
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ dismissed: true });
    expect(catalogImport.cancel).toHaveBeenCalledTimes(1);
    expect(catalogImport.dismiss).toHaveBeenCalledTimes(1);
  });

  it('checks the hosted source again on the owner\'s request', async () => {
    const { app, catalogImport } = createApp();
    const checked = await request(app).post('/api/bots/database/import/check').send({ url: 'https://example.test' });
    expect(checked.status).toBe(200);
    expect(checked.headers['cache-control']).toBe('no-store');
    expect(checked.body).toEqual({ cloud: { hasBots: true, code: null }, checking: false, import: null, pending: true });
    // The request carries no source of its own: the saved one is always used.
    expect(catalogImport.probeCloud).toHaveBeenCalledWith({ requested: true });

    catalogImport.probeCloud.mockRejectedValueOnce(Object.assign(new Error('Import state is unreadable'), {
      code: 'bot_import_state_invalid', statusCode: 500,
    }));
    const failed = await request(app).post('/api/bots/database/import/check').send({});
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ code: 'bot_import_state_invalid' });
  });

  it('does not register import routes without an import service', async () => {
    const { app } = createApp({ catalogImport: null });
    for (const [method, route] of [
      ['get', '/api/bots/database/import'],
      ['post', '/api/bots/database/import'],
      ['post', '/api/bots/database/import/check'],
      ['post', '/api/bots/database/import/cancel'],
      ['post', '/api/bots/database/import/dismiss'],
    ]) {
      const response = await send(app, method, route, method === 'post' ? {} : undefined);
      expect(response.status).toBe(404);
    }
  });

  describe('error envelope', () => {
    const failWith = async (error, { route = '/api/bots/database/restore', method = 'post' } = {}) => {
      const maintenance = createMaintenance();
      maintenance.restore.mockImplementation(async () => { throw error; });
      maintenance.listBackups.mockImplementation(async () => { throw error; });
      const catalogImport = createCatalogImport();
      catalogImport.start.mockImplementation(async () => { throw error; });
      catalogImport.cancel.mockImplementation(async () => { throw error; });
      catalogImport.dismiss.mockImplementation(async () => { throw error; });
      const { app } = createApp({ maintenance, catalogImport });
      return send(app, method, route, method === 'post' ? { backupId: BACKUP_ID } : undefined);
    };

    it('uses statusCode, then status, then the 503 fallback', async () => {
      const byStatusCode = await failWith(Object.assign(new Error('bad confirmation'), {
        code: 'bot_restore_confirmation_required', statusCode: 400, status: 409,
      }));
      expect(byStatusCode.status).toBe(400);
      expect(byStatusCode.body).toEqual({
        error: 'bad confirmation', code: 'bot_restore_confirmation_required', retryable: false,
      });

      const byStatus = await failWith(Object.assign(new Error('missing'), { code: 'bot_backup_not_found', status: 404 }));
      expect(byStatus.status).toBe(404);

      const fallback = await failWith(Object.assign(new Error('boom'), { code: 'bot_backup_failed' }));
      expect(fallback.status).toBe(503);

      for (const statusCode of [200, 302, 399, 600, 700, 404.5]) {
        const response = await failWith(Object.assign(new Error('x'), { code: 'bot_backup_failed', statusCode }));
        expect(response.status).toBe(503);
      }
    });

    it('sanitizes codes and messages', async () => {
      for (const code of ['Bad-Code', 'UPPER', '1leading_digit', 'has space', '', 42, null, `a${'b'.repeat(120)}`]) {
        const response = await failWith(Object.assign(new Error('x'), { code, statusCode: 409 }));
        expect(response.body.code).toBe('bot_catalog_operation_failed');
      }
      const longest = `a${'b'.repeat(119)}`;
      expect((await failWith(Object.assign(new Error('x'), { code: longest }))).body.code).toBe(longest);

      const multiline = await failWith(Object.assign(new Error('line one\r\nline two\0end'), { code: 'bot_x' }));
      expect(multiline.body.error).toBe('line one  line two end');
      expect(multiline.body.error).not.toMatch(/[\r\n\0]/);

      const long = await failWith(Object.assign(new Error('y'.repeat(1000)), { code: 'bot_x' }));
      expect(long.body.error).toBe('y'.repeat(300));

      const nonError = await failWith({ code: 'bot_x', statusCode: 422 });
      expect(nonError.status).toBe(422);
      expect(nonError.body).toEqual({ error: 'Bot catalog operation failed', code: 'bot_x', retryable: false });

      const thrownString = await failWith('plain failure');
      expect(thrownString.status).toBe(503);
      expect(thrownString.body).toEqual({
        error: 'Bot catalog operation failed', code: 'bot_catalog_operation_failed', retryable: false,
      });
    });

    it('marks only explicit or maintenance-busy failures retryable', async () => {
      const busy = await failWith(Object.assign(new Error('busy'), { code: 'bots_maintenance_busy', statusCode: 409 }));
      expect(busy.status).toBe(409);
      expect(busy.body.retryable).toBe(true);

      const explicit = await failWith(Object.assign(new Error('quota'), {
        code: 'bot_import_source_quota_exceeded', statusCode: 409, retryable: true,
      }), { route: '/api/bots/database/import' });
      expect(explicit.body).toEqual({ error: 'quota', code: 'bot_import_source_quota_exceeded', retryable: true });

      for (const retryable of ['true', 1, {}]) {
        const response = await failWith(Object.assign(new Error('x'), { code: 'bot_x', retryable }));
        expect(response.body.retryable).toBe(false);
      }
    });

    it('filters blockers to at most eight strings', async () => {
      const response = await failWith(Object.assign(new Error('blocked'), {
        code: 'bots_maintenance_busy',
        statusCode: 409,
        blockers: ['runs', 1, null, 'routines', { a: 1 }, 'telegram', 'speech', 'memory', 'outbox', 'inbox', 'recovery', 'extra'],
      }));
      expect(response.body.blockers).toEqual(['runs', 'routines', 'telegram', 'speech', 'memory', 'outbox', 'inbox', 'recovery']);

      const notArray = await failWith(Object.assign(new Error('x'), { code: 'bot_x', blockers: 'runs' }));
      expect(notArray.body).not.toHaveProperty('blockers');
      const empty = await failWith(Object.assign(new Error('x'), { code: 'bot_x', blockers: [] }));
      expect(empty.body.blockers).toEqual([]);
    });

    it('applies the envelope on every owner route that can fail', async () => {
      const error = Object.assign(new Error('busy\nnow'), { code: 'bots_maintenance_busy', statusCode: 409, blockers: ['runs'] });
      for (const [method, route] of [
        ['get', '/api/bots/database/backups'],
        ['post', '/api/bots/database/restore'],
        ['post', '/api/bots/database/import'],
        ['post', '/api/bots/database/import/cancel'],
        ['post', '/api/bots/database/import/dismiss'],
      ]) {
        const response = await failWith(error, { method, route });
        expect({ route, status: response.status, body: response.body }).toEqual({
          route,
          status: 409,
          body: { error: 'busy now', code: 'bots_maintenance_busy', retryable: true, blockers: ['runs'] },
        });
      }
    });
  });
});
