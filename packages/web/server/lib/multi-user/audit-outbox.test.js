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
  it('preserves only constrained top-level diagnostic classification fields', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-diagnostic-'));
    temporaryDirectories.push(directory);
    const rest = vi.fn(async (_table, request) => request.body);
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });

    await outbox.enqueue('6e49b7c8-97f4-43ef-8cc7-f34ea509f078', {
      actor_user_id: '11111111-1111-4111-8111-111111111111',
      action: 'tool.failed',
      diagnostic_impact: 'low',
      diagnostic_source: 'observed',
      success: false,
      metadata: {
        failureClass: 'filesystem_target',
        originalEventId: '77777777-7777-4777-8777-777777777777',
      },
    });

    expect(rest.mock.calls.at(-1)[1].body).toMatchObject({
      diagnostic_impact: 'low',
      diagnostic_source: 'observed',
      metadata: {
        failureClass: 'filesystem_target',
        originalEventId: '77777777-7777-4777-8777-777777777777',
      },
    });
    await outbox.drain();
  });

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

  it('flushes backlog and blocks concurrent delivery during protected operations', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-barrier-'));
    temporaryDirectories.push(directory);
    let shouldFail = true;
    const deliveredEventIds = [];
    const rest = vi.fn(async (_table, request) => {
      if (shouldFail) throw new Error('Supabase unavailable');
      deliveredEventIds.push(request.body.event_id);
      return request.body;
    });
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });
    const oldEventId = '88888888-8888-4888-8888-888888888888';
    const newEventId = '99999999-9999-4999-8999-999999999999';

    await outbox.enqueue(oldEventId, { action: 'tool.failed', metadata: {} });
    expect(await outbox.getStatus()).toMatchObject({ backlog: 1 });
    shouldFail = false;

    let enterBarrier;
    let releaseBarrier;
    const barrierEntered = new Promise((resolve) => { enterBarrier = resolve; });
    const barrierGate = new Promise((resolve) => { releaseBarrier = resolve; });
    const protectedOperation = outbox.withFlushedDeliveryBarrier(async () => {
      enterBarrier();
      await barrierGate;
      return 'cleared';
    });
    await barrierEntered;

    const newDelivery = outbox.enqueue(newEventId, { action: 'session.error', metadata: {} });
    await Promise.resolve();
    expect(deliveredEventIds).toEqual([oldEventId]);

    releaseBarrier();
    await expect(protectedOperation).resolves.toBe('cleared');
    await newDelivery;
    expect(deliveredEventIds).toEqual([oldEventId, newEventId]);
    await outbox.drain();
  });

  it('releases the delivery barrier when the protected operation fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-barrier-failure-'));
    temporaryDirectories.push(directory);
    const rest = vi.fn(async (_table, request) => request.body);
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });

    await expect(outbox.withFlushedDeliveryBarrier(async () => {
      throw new Error('clear failed');
    })).rejects.toThrow('clear failed');
    await expect(outbox.enqueue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      action: 'tool.failed',
      metadata: {},
    })).resolves.toBeUndefined();
    expect(rest).toHaveBeenCalledTimes(1);
    await outbox.drain();
  });

  it('does not enter a protected operation while durable backlog remains undelivered', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-barrier-backlog-'));
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
    await outbox.enqueue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      action: 'tool.failed',
      metadata: {},
    });
    const protectedOperation = vi.fn(async () => 'cleared');

    await expect(outbox.withFlushedDeliveryBarrier(protectedOperation)).rejects.toMatchObject({
      code: 'DEVRYAN_AUDIT_OUTBOX_NOT_FLUSHED',
    });
    expect(protectedOperation).not.toHaveBeenCalled();

    shouldFail = false;
    await outbox.flush();
    await expect(outbox.withFlushedDeliveryBarrier(protectedOperation)).resolves.toBe('cleared');
    await outbox.drain();
  });

  it('sanitizes clipboard text and derives a bounded preview before delivery', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-clipboard-'));
    temporaryDirectories.push(directory);
    const rest = vi.fn(async (_table, request) => request.body);
    const outbox = await createAuditOutbox({
      dataDirectory: directory,
      supabase: { rest },
      logger: { warn() {} },
      flushIntervalMs: 60_000,
    });
    const copiedText = `copied sk-abcdefghijklmnopqrstuvwxyz1234567890 value`;

    await outbox.enqueue('55555555-5555-4555-8555-555555555555', {
      actor_user_id: '11111111-1111-4111-8111-111111111111',
      actor_role: 'developer',
      action: 'clipboard.copied',
      clipboard_text: copiedText,
      clipboard_text_original_length: copiedText.length,
      clipboard_text_truncated: false,
      metadata: { characterCount: copiedText.length },
    });

    const delivered = rest.mock.calls.at(-1)[1].body;
    expect(delivered.clipboard_text).toContain('[REDACTED]:provider_token');
    expect(delivered.clipboard_text).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    expect(delivered.clipboard_text_preview).toBe(delivered.clipboard_text.slice(0, 512));
    expect(delivered.clipboard_text_original_length).toBe(copiedText.length);
    expect(delivered.clipboard_text_truncated).toBe(false);
    expect(delivered.clipboard_text_redacted).toBe(true);
    await outbox.drain();
  });

  it('never holds callers behind a black-holed backend and keeps a single delivery in flight', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-blackhole-'));
    temporaryDirectories.push(directory);
    let inFlight = 0, maxInFlight = 0, recovered = false;
    const pending = [];
    const rest = vi.fn((_table, request) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      const answer = recovered ? Promise.resolve(request.body)
        : new Promise((resolve, reject) => pending.push({ resolve, reject, request }));
      return answer.finally(() => { inFlight -= 1; });
    });
    const outbox = await createAuditOutbox({ dataDirectory: directory, supabase: { rest }, logger: { warn() {} }, flushIntervalMs: 60_000 });
    const started = Date.now();
    await outbox.enqueue('c0000000-0000-4000-8000-000000000000', { action: 'git.commit', metadata: {} });
    for (let index = 1; index <= 20; index += 1) {
      await outbox.enqueue(`c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, { action: 'git.commit', metadata: {} });
      await outbox.enqueueDeferred(`d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, { action: 'prompt', metadata: {} });
    }
    // The first caller waits at most the bounded delivery window; the rest do not wait.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(maxInFlight).toBe(1);
    expect(await outbox.getStatus()).toMatchObject({ backlog: 41 });
    // The backend recovers: the in-flight request completes and a coalesced
    // flush delivers everything in batches of passes, still one at a time.
    recovered = true;
    while (pending.length) { const entry = pending.shift(); entry.resolve(entry.request.body); }
    for (let attempt = 0; attempt < 5 && (await outbox.getStatus()).backlog > 0; attempt += 1) await outbox.flush();
    expect((await outbox.getStatus()).backlog).toBe(0);
    expect(maxInFlight).toBe(1);
    await outbox.drain();
  }, 20_000);

  it('stops a pass at an unavailable backend but skips a single rejected record', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-pass-'));
    temporaryDirectories.push(directory);
    let mode = 'down';
    const rest = vi.fn(async (_table, request) => {
      if (mode === 'down') throw Object.assign(new Error('fetch failed'), { status: 503 });
      if (request.body.action === 'bad.record') throw Object.assign(new Error('violates check constraint'), { status: 400 });
      return request.body;
    });
    const outbox = await createAuditOutbox({ dataDirectory: directory, supabase: { rest }, logger: { warn() {} }, flushIntervalMs: 60_000 });
    for (const [id, action] of [['e0000000-0000-4000-8000-000000000001', 'bad.record'], ['e0000000-0000-4000-8000-000000000002', 'ok'], ['e0000000-0000-4000-8000-000000000003', 'ok']]) {
      await outbox.enqueueDeferred(id, { action, metadata: {} });
    }
    await outbox.flush(); // Settles the background pass the enqueues requested.
    rest.mockClear();
    await outbox.flush();
    // The first failure and one probe of the next record, never the whole backlog.
    expect(rest).toHaveBeenCalledTimes(2);
    expect((await outbox.getStatus()).retryAfterMs).toBeGreaterThan(0);
    mode = 'up';
    await outbox.flush();
    expect((await outbox.getStatus()).backlog).toBe(1);
    await outbox.drain();
  });

  it('keeps delivering later records while one record keeps failing', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-poison-'));
    temporaryDirectories.push(directory);
    const rest = vi.fn(async (_table, request) => {
      if (request.body.action === 'poison') throw Object.assign(new Error('statement timeout'), { status: 500 });
      return request.body;
    });
    const outbox = await createAuditOutbox({ dataDirectory: directory, supabase: { rest }, logger: { warn() {} }, flushIntervalMs: 60_000 });
    await outbox.enqueueDeferred('f0000000-0000-4000-8000-000000000001', { action: 'poison', metadata: {} });
    await outbox.enqueueDeferred('f0000000-0000-4000-8000-000000000009', { action: 'poison', metadata: {} });
    await outbox.flush(); // Both failing records now carry an attempt.
    for (let index = 2; index <= 6; index += 1) {
      await outbox.enqueueDeferred(`f0000000-0000-4000-8000-00000000000${index}`, { action: 'healthy', metadata: {} });
    }
    await outbox.flush();
    expect((await outbox.getStatus()).backlog).toBe(2);
    expect(rest.mock.calls.filter(([, request]) => request.body.action === 'healthy')).toHaveLength(5);
    await outbox.drain();
  });

  it('never backs the whole outbox off for one record that keeps failing', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-lone-poison-'));
    temporaryDirectories.push(directory);
    const rest = vi.fn(async (_table, request) => {
      if (request.body.action === 'poison') throw Object.assign(new Error('statement timeout'), { status: 500 });
      return request.body;
    });
    const outbox = await createAuditOutbox({ dataDirectory: directory, supabase: { rest }, logger: { warn() {} }, flushIntervalMs: 60_000 });
    await outbox.enqueueDeferred('d0000000-0000-4000-8000-000000000001', { action: 'poison', metadata: {} });
    for (let pass = 0; pass < 6; pass += 1) await outbox.flush();
    // Only the first (fresh) failure may start a short shared backoff.
    expect((await outbox.getStatus()).retryAfterMs).toBeLessThan(61_000);
    await outbox.enqueueDeferred('d0000000-0000-4000-8000-000000000002', { action: 'healthy', metadata: {} });
    await outbox.flush();
    expect(rest.mock.calls.filter(([, request]) => request.body.action === 'healthy')).toHaveLength(1);
    expect((await outbox.getStatus()).backlog).toBe(1);
    await outbox.drain();
  });

  it('runs a delivery barrier and an explicit flush while steady traffic keeps arriving', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-audit-traffic-'));
    temporaryDirectories.push(directory);
    const rest = vi.fn(async (_table, request) => { await new Promise((resolve) => setTimeout(resolve, 10)); return request.body; });
    const outbox = await createAuditOutbox({ dataDirectory: directory, supabase: { rest }, logger: { warn() {} }, flushIntervalMs: 60_000 });
    let traffic = true, sent = 0;
    const pump = (async () => {
      const until = Date.now() + 1_500;
      while (Date.now() < until) {
        sent += 1;
        void outbox.enqueueDeferred(`c0000000-0000-4000-8000-${String(sent).padStart(12, '0')}`, { action: 'fixture.event', metadata: {} });
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      traffic = false;
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(outbox.withFlushedDeliveryBarrier(() => traffic)).resolves.toBe(true);
    await outbox.flush();
    expect(traffic).toBe(true);
    await pump;
    await outbox.flush();
    expect((await outbox.getStatus()).backlog).toBe(0);
    expect(rest).toHaveBeenCalledTimes(sent);
    await outbox.drain();
  });
});
