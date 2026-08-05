import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditOutbox } from './audit-outbox.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('durable activity outbox', () => {
  it('retains failed events and retries them idempotently with sanitized payloads', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-'));
    temporaryDirectories.push(directory);
    let shouldFail = true;
    const rest = vi.fn(async (_table, request) => {
      if (shouldFail) throw new Error('Supabase unavailable');
      return request.body;
    });
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });

    await outbox.enqueue('7e49b7c8-97f4-43ef-8cc7-f34ea509f078', {
      actor_user_id: '11111111-1111-4111-8111-111111111111',
      actor_role: 'developer',
      action: 'session.created',
      project_id: '22222222-2222-4222-8222-222222222222',
      session_id: 'ses_03b3ebfc7ffeigRpL1Z1',
      metadata: {
        directory: path.join(os.homedir(), 'Repositories', 'private-project'),
        requestedEventId: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(await outbox.getStatus()).toMatchObject({ backlog: 1, deliveryFailures: 1 });

    shouldFail = false;
    await outbox.flush();
    const status = await outbox.getStatus();
    expect(status.backlog).toBe(0);
    expect(status.delivered).toBe(1);
    const delivered = rest.mock.calls.at(-1)[1];
    expect(delivered.body.event_id).toBe('7e49b7c8-97f4-43ef-8cc7-f34ea509f078');
    expect(delivered.body.actor_user_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(delivered.body.project_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(delivered.body.session_id).toBe('ses_03b3ebfc7ffeigRpL1Z1');
    expect(delivered.body.metadata.directory).not.toContain(os.homedir());
    expect(delivered.body.metadata.requestedEventId).toBe('33333333-3333-4333-8333-333333333333');
    expect(delivered.query).toEqual({ on_conflict: 'event_id' });
    expect(delivered.prefer).toContain('ignore-duplicates');
    await outbox.drain();
  });

  it('repairs legacy redacted UUID columns so a poisoned backlog can drain', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-repair-'));
    temporaryDirectories.push(directory);
    const outboxDirectory = path.join(directory, 'multi-user', 'audit-outbox');
    await fs.mkdir(outboxDirectory, { recursive: true });
    const eventId = '33333333-3333-4333-8333-333333333333';
    await fs.writeFile(path.join(outboxDirectory, `${eventId}.json`), JSON.stringify({
      version: 1,
      key: eventId,
      record: {
        payload: {
          actor_user_id: '[REDACTED]:high_entropy',
          target_user_id: '[REDACTED]:high_entropy',
          project_id: '[REDACTED]:high_entropy',
          actor_role: 'admin',
          action: 'tool.completed',
          metadata: {},
          success: true,
        },
        attempts: 4,
        createdAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        lastError: 'invalid input syntax for type uuid',
      },
    }), { mode: 0o600 });

    const rest = vi.fn(async (_table, request) => request.body);
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });
    await outbox.flush();

    expect(await outbox.getStatus()).toMatchObject({ backlog: 0 });
    expect(rest.mock.calls.at(-1)[1].body).toMatchObject({
      event_id: eventId,
      actor_user_id: null,
      target_user_id: null,
      project_id: null,
    });
    await outbox.drain();
  });

  it('durably enqueues telemetry without waiting for remote delivery and preserves occurrence time', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-deferred-'));
    temporaryDirectories.push(directory);
    let releaseDelivery;
    const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
    const rest = vi.fn(async () => deliveryGate);
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });
    const occurredAt = '2026-08-05T13:04:05.000Z';

    await expect(outbox.enqueueDeferred('44444444-4444-4444-8444-444444444444', {
      actor_user_id: '11111111-1111-4111-8111-111111111111',
      actor_role: 'developer',
      action: 'file.opened',
      created_at: occurredAt,
      metadata: { filePath: 'src/index.ts' },
    })).resolves.toBeUndefined();
    expect(await outbox.getStatus()).toMatchObject({ backlog: 1 });

    releaseDelivery();
    await outbox.flush();
    expect(rest.mock.calls.at(-1)[1].body.created_at).toBe(occurredAt);
    await outbox.drain();
  });
});
