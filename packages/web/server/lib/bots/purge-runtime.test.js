import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BOT_PURGE_RESOURCE_IDS,
  BotPurgeRuntimeError,
  createBotPurgeRuntime,
} from './purge-runtime.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'a0000000-0000-4000-8000-000000000002';
const JOB_ID = 'c0000000-0000-4000-8000-000000000001';
const UPDATED_AT = '2026-08-23T09:00:00.000Z';
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-purge-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createClock = () => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 23, 10, 0, tick));
  };
};

const principal = Object.freeze({ id: USER_ID, role: 'manager', scope: 'managed' });

const createHarness = async ({
  dataDirectory,
  lifecycle = 'retired',
  failResourceOnce = null,
  failAuditBarrierOnce = false,
  isGlobalAdmin = () => false,
} = {}) => {
  const directory = dataDirectory || await createTemporaryDirectory();
  const calls = [];
  let currentLifecycle = lifecycle;
  let currentUpdatedAt = UPDATED_AT;
  const failures = new Set(failResourceOnce ? [failResourceOnce] : []);
  const adapter = {
    prepare: vi.fn(async () => ({
      bot: {
        id: BOT_ID,
        name: 'Release Sentinel',
        lifecycle: currentLifecycle,
        updatedAt: currentUpdatedAt,
      },
      snapshot: {
        botId: BOT_ID,
        storageNames: ['bots/team/object-one'],
        channelIds: ['d0000000-0000-4000-8000-000000000001'],
      },
    })),
    stopRuntimeContainers: vi.fn(async (_snapshot, selectedResourceIds) => {
      calls.push('runtime-containers');
      expect(selectedResourceIds).toEqual(expect.arrayContaining(
        selectedResourceIds.filter((id) => ['browser_profiles', 'workspaces'].includes(id)),
      ));
      return { detail: 'Scoped runtime containers stopped' };
    }),
    purgeResource: vi.fn(async (resourceId, snapshot) => {
      calls.push(`resource:${resourceId}`);
      expect(snapshot.botId).toBe(BOT_ID);
      if (failures.delete(resourceId)) {
        throw Object.assign(new Error(`Could not purge ${resourceId} at /private/runtime/path`), {
          code: `${resourceId}_unavailable`,
        });
      }
      return { detail: `${resourceId} removed` };
    }),
    purgeSupabaseRows: vi.fn(async (snapshot, selectedResourceIds, { deleteBot }) => {
      calls.push(deleteBot ? 'supabase:delete-bot' : 'supabase:retain-bot');
      expect(snapshot.botId).toBe(BOT_ID);
      expect(selectedResourceIds.length).toBeGreaterThan(0);
      return { detail: deleteBot
        ? 'Supabase rows and Bot removed'
        : 'Supabase rows removed; Bot retained' };
    }),
  };
  const authorization = {
    requireManager: vi.fn(async (candidate, botId) => {
      if (candidate?.id !== USER_ID || botId !== BOT_ID) {
        throw Object.assign(new Error('forbidden'), { code: 'bot_manager_required' });
      }
    }),
  };
  const audit = vi.fn(async (entry) => {
    calls.push(`audit:${entry.action}`);
  });
  let auditBarrierShouldFail = failAuditBarrierOnce;
  const withAuditDeliveryBarrier = vi.fn(async (operation) => {
    calls.push('audit-barrier:start');
    if (auditBarrierShouldFail) {
      auditBarrierShouldFail = false;
      throw Object.assign(new Error('Audit outbox backlog could not be delivered'), {
        code: 'DEVRYAN_AUDIT_OUTBOX_NOT_FLUSHED',
      });
    }
    const result = await operation();
    calls.push('audit-barrier:end');
    return result;
  });
  const auditRetention = {
    prune: vi.fn(() => withAuditDeliveryBarrier(async () => {
      calls.push('audit-prune');
    })),
  };
  const retireBot = vi.fn(async (_principal, botId, expectedUpdatedAt) => {
    expect(botId).toBe(BOT_ID);
    expect(expectedUpdatedAt).toBe(currentUpdatedAt);
    currentLifecycle = 'retired';
    currentUpdatedAt = '2026-08-23T09:00:01.000Z';
  });
  const runtime = createBotPurgeRuntime({
    dataDirectory: directory,
    authorization,
    adapter,
    audit,
    auditRetention,
    retireBot,
    isGlobalAdmin,
    now: createClock(),
    uuid: () => JOB_ID,
  });
  return {
    adapter,
    audit,
    auditRetention,
    authorization,
    calls,
    dataDirectory: directory,
    runtime,
    retireBot,
    withAuditDeliveryBarrier,
  };
};

const startRequest = (resourceIds = BOT_PURGE_RESOURCE_IDS) => ({
  typedName: 'Release Sentinel',
  confirm: true,
  expectedUpdatedAt: UPDATED_AT,
  resourceIds,
});

const completeDeleteRequest = () => ({
  typedName: 'Release Sentinel',
  confirm: true,
  expectedUpdatedAt: UPDATED_AT,
});

describe('Production Bot resumable purge runtime', () => {
  it.each(['active', 'paused'])('retires an %s Bot and deletes every resource in one request', async (lifecycle) => {
    const harness = await createHarness({ lifecycle });

    const result = await harness.runtime.startComplete(
      principal,
      BOT_ID,
      completeDeleteRequest(),
    );

    expect(harness.retireBot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ complete: true, botDeleted: true });
    expect(result.selectedResourceIds).toEqual(BOT_PURGE_RESOURCE_IDS);
    expect(harness.adapter.purgeSupabaseRows).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID }),
      BOT_PURGE_RESOURCE_IDS,
      { deleteBot: true },
    );
  });

  it('deletes a Draft without attempting retirement', async () => {
    const harness = await createHarness({ lifecycle: 'draft' });

    const result = await harness.runtime.startComplete(
      principal,
      BOT_ID,
      completeDeleteRequest(),
    );

    expect(harness.retireBot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ complete: true, botDeleted: true });
  });

  it('continues from a completed granular purge into a fresh full deletion job', async () => {
    const harness = await createHarness();
    await harness.runtime.start(
      principal,
      BOT_ID,
      startRequest(['capability_bindings', 'objects', 'channels', 'shared_memory']),
    );

    const result = await harness.runtime.startComplete(
      principal,
      BOT_ID,
      completeDeleteRequest(),
    );

    expect(result).toMatchObject({ complete: true, botDeleted: true });
    expect(result.selectedResourceIds).toEqual(BOT_PURGE_RESOURCE_IDS);
    expect(harness.adapter.purgeSupabaseRows).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: BOT_ID }),
      BOT_PURGE_RESOURCE_IDS,
      { deleteBot: true },
    );
  });

  it('automatically resumes an incomplete full purge without a retry selection', async () => {
    const harness = await createHarness({ failResourceOnce: 'browser_profiles' });
    const partial = await harness.runtime.start(
      principal,
      BOT_ID,
      startRequest(),
    );
    expect(partial.complete).toBe(false);

    const completed = await harness.runtime.startComplete(
      principal,
      BOT_ID,
      completeDeleteRequest(),
    );

    expect(completed).toMatchObject({ complete: true, botDeleted: true });
    expect(harness.adapter.prepare).toHaveBeenCalledTimes(1);
  });
  it('keeps granular channel and shared-memory deletion separate from full Bot deletion', async () => {
    const harness = await createHarness();

    await expect(harness.runtime.start(principal, BOT_ID, startRequest(['channels'])))
      .rejects.toMatchObject({
        code: 'bot_purge_dependency_required',
        statusCode: 409,
      });

    const result = await harness.runtime.start(
      principal,
      BOT_ID,
      startRequest(['capability_bindings', 'objects', 'channels', 'shared_memory']),
    );

    expect(result).toMatchObject({
      botId: BOT_ID,
      complete: true,
      botDeleted: false,
      state: 'completed',
      selectedResourceIds: ['capability_bindings', 'objects', 'channels', 'shared_memory'],
    });
    expect(harness.adapter.purgeResource.mock.calls.map(([id]) => id)).toEqual([
      'capability_bindings',
      'objects',
      'channels',
      'shared_memory',
    ]);
    expect(harness.adapter.purgeSupabaseRows).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID }),
      ['capability_bindings', 'objects', 'channels', 'shared_memory'],
      { deleteBot: false },
    );
    expect(result.steps.find((step) => step.id === 'supabase_rows')).toMatchObject({
      status: 'completed',
    });

    const repeated = await harness.runtime.start(
      principal,
      BOT_ID,
      startRequest(['capability_bindings', 'objects', 'channels']),
    );
    expect(repeated).toMatchObject({
      complete: true,
      selectedResourceIds: ['capability_bindings', 'objects', 'channels'],
    });
    expect(harness.adapter.purgeResource.mock.calls.map(([id]) => id)).toEqual([
      'capability_bindings',
      'objects',
      'channels',
      'shared_memory',
      'capability_bindings',
      'objects',
      'channels',
    ]);
  });

  it('does not delete channels until their encrypted objects have been removed', async () => {
    const harness = await createHarness({ failResourceOnce: 'objects' });

    const partial = await harness.runtime.start(
      principal,
      BOT_ID,
      startRequest(['capability_bindings', 'objects', 'channels']),
    );

    expect(partial.botDeleted).toBe(false);
    expect(partial.steps.find((step) => step.id === 'objects')?.status).toBe('failed');
    expect(partial.steps.find((step) => step.id === 'channels')?.status).toBe('pending');
    expect(harness.adapter.purgeResource.mock.calls.map(([id]) => id)).toEqual([
      'capability_bindings',
      'objects',
    ]);
    expect(harness.adapter.purgeSupabaseRows).not.toHaveBeenCalled();

    const completed = await harness.runtime.retry(principal, BOT_ID, {
      resourceIds: ['objects', 'channels'],
    });
    expect(completed).toMatchObject({ complete: true, botDeleted: false });
    expect(harness.adapter.purgeResource.mock.calls.map(([id]) => id)).toEqual([
      'capability_bindings',
      'objects',
      'objects',
      'channels',
    ]);
  });

  it('persists partial failures and resumes only failed work after a process restart', async () => {
    const first = await createHarness({ failResourceOnce: 'browser_profiles' });

    const partial = await first.runtime.start(principal, BOT_ID, startRequest());

    expect(partial).toMatchObject({ state: 'partial', complete: false, retryable: true });
    expect(partial.steps.find((step) => step.id === 'browser_profiles')).toMatchObject({
      status: 'failed',
      attempts: 1,
      code: 'browser_profiles_unavailable',
    });
    expect(partial.steps.find((step) => step.id === 'browser_profiles').detail)
      .toContain('<LOCAL_PATH>');
    expect(first.adapter.purgeSupabaseRows).not.toHaveBeenCalled();
    expect(first.auditRetention.prune).not.toHaveBeenCalled();

    const second = await createHarness({ dataDirectory: first.dataDirectory });
    const recovered = await second.runtime.get(principal, BOT_ID);
    expect(recovered).toMatchObject({ id: JOB_ID, state: 'partial' });

    const completed = await second.runtime.retry(principal, BOT_ID, {
      resourceIds: ['browser_profiles'],
    });

    expect(completed).toMatchObject({ state: 'completed', complete: true, retryable: false });
    expect(second.adapter.prepare).not.toHaveBeenCalled();
    expect(second.adapter.purgeResource).toHaveBeenCalledTimes(1);
    expect(second.adapter.purgeResource).toHaveBeenCalledWith(
      'browser_profiles',
      expect.objectContaining({ botId: BOT_ID }),
    );
    expect(second.adapter.purgeSupabaseRows).toHaveBeenCalledTimes(1);
    expect(second.calls).toEqual(expect.arrayContaining([
      'resource:browser_profiles',
      'supabase:delete-bot',
      'audit-barrier:start',
      'audit-prune',
      'audit-barrier:end',
      'audit:bot.purge.completed',
    ]));
    expect(second.calls.indexOf('supabase:delete-bot')).toBeLessThan(
      second.calls.indexOf('audit-barrier:start'),
    );
    expect(second.calls.indexOf('audit-barrier:end')).toBeLessThan(
      second.calls.indexOf('audit:bot.purge.completed'),
    );
    expect(second.withAuditDeliveryBarrier).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable partial result when the audit backlog cannot cross the barrier', async () => {
    const harness = await createHarness({ failAuditBarrierOnce: true });

    const partial = await harness.runtime.startComplete(
      principal,
      BOT_ID,
      completeDeleteRequest(),
    );

    expect(partial).toMatchObject({ state: 'partial', complete: false, retryable: true, botDeleted: true });
    expect(partial.steps.find((step) => step.id === 'audit_retention')).toMatchObject({
      status: 'failed',
      code: 'DEVRYAN_AUDIT_OUTBOX_NOT_FLUSHED',
    });
    expect(harness.withAuditDeliveryBarrier).toHaveBeenCalledTimes(1);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.purge.partial',
      result: 'partial',
    }));
  });

  it('turns a crash-time running journal into explicit idempotent retry work', async () => {
    const first = await createHarness({ failResourceOnce: 'browser_profiles' });
    await first.runtime.start(principal, BOT_ID, startRequest());
    const journalPath = path.join(first.dataDirectory, 'bots', 'purge', `${BOT_ID}.v1.json`);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    journal.state = 'running';
    journal.steps.browser_profiles.status = 'running';
    await fs.writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    const second = await createHarness({ dataDirectory: first.dataDirectory });
    const recovered = await second.runtime.get(principal, BOT_ID);
    const interruptedIds = recovered.steps
      .filter((step) => step.status === 'failed')
      .map((step) => step.id);

    expect(recovered).toMatchObject({ state: 'partial', retryable: true });
    expect(interruptedIds).toEqual(expect.arrayContaining([
      'browser_profiles',
      'supabase_rows',
      'audit_retention',
    ]));
    const completed = await second.runtime.retry(principal, BOT_ID, {
      resourceIds: interruptedIds,
    });
    expect(completed).toMatchObject({ state: 'completed', complete: true });
  });

  it('recovers an interrupted post-delete audit step without repeating destructive work', async () => {
    const first = await createHarness();
    await first.runtime.startComplete(principal, BOT_ID, completeDeleteRequest());
    const journalPath = path.join(first.dataDirectory, 'bots', 'purge', `${BOT_ID}.v1.json`);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    journal.state = 'running';
    journal.completedAt = null;
    journal.steps.audit_retention.status = 'running';
    journal.steps.audit_retention.completedAt = null;
    await fs.writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    const second = await createHarness({ dataDirectory: first.dataDirectory });
    const recovered = await second.runtime.get(principal, BOT_ID);
    expect(recovered).toMatchObject({ state: 'partial', retryable: true, botDeleted: true });
    expect(recovered.steps.find((step) => step.id === 'audit_retention')).toMatchObject({
      status: 'failed',
      code: 'bot_purge_interrupted',
    });

    const completed = await second.runtime.retry(principal, BOT_ID, {
      resourceIds: ['audit_retention'],
    });
    expect(completed).toMatchObject({ state: 'completed', complete: true, botDeleted: true });
    expect(second.authorization.requireManager).not.toHaveBeenCalled();
    expect(second.adapter.prepare).not.toHaveBeenCalled();
    expect(second.adapter.purgeResource).not.toHaveBeenCalled();
    expect(second.adapter.purgeSupabaseRows).not.toHaveBeenCalled();
    expect(second.auditRetention.prune).toHaveBeenCalledTimes(1);
  });

  it('allows Setup Incomplete Drafts to purge without activation or retirement', async () => {
    const harness = await createHarness({ lifecycle: 'draft' });

    const result = await harness.runtime.start(principal, BOT_ID, startRequest());

    expect(result).toMatchObject({ state: 'completed', complete: true, botDeleted: true });
    expect(harness.adapter.purgeSupabaseRows).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID }),
      BOT_PURGE_RESOURCE_IDS,
      { deleteBot: true },
    );
  });

  it('requires active and paused Bots to retire, plus exact name, confirmation, and revision', async () => {
    const active = await createHarness({ lifecycle: 'active' });
    await expect(active.runtime.start(principal, BOT_ID, startRequest()))
      .rejects.toMatchObject({ code: 'bot_purge_requires_retired' });
    const paused = await createHarness({ lifecycle: 'paused' });
    await expect(paused.runtime.start(principal, BOT_ID, startRequest()))
      .rejects.toMatchObject({ code: 'bot_purge_requires_retired' });

    const harness = await createHarness();
    await expect(harness.runtime.start(principal, BOT_ID, {
      ...startRequest(),
      typedName: 'release sentinel',
    })).rejects.toMatchObject({ code: 'bot_purge_confirmation_required' });
    await expect(harness.runtime.start(principal, BOT_ID, {
      ...startRequest(),
      confirm: false,
    })).rejects.toMatchObject({ code: 'bot_purge_confirmation_required' });
    await expect(harness.runtime.start(principal, BOT_ID, {
      ...startRequest(),
      expectedUpdatedAt: '2026-08-23T09:01:00.000Z',
    })).rejects.toMatchObject({ code: 'bot_revision_conflict' });
    expect(harness.adapter.purgeResource).not.toHaveBeenCalled();
  });

  it('runs every destructive resource once before deleting the Bot control plane', async () => {
    const harness = await createHarness();

    const result = await harness.runtime.start(principal, BOT_ID, startRequest());

    expect(result.complete).toBe(true);
    expect(result.botDeleted).toBe(true);
    expect(result.steps.find((step) => step.id === 'runtime_containers')).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    expect(harness.adapter.purgeResource.mock.calls.map(([id]) => id))
      .toEqual(BOT_PURGE_RESOURCE_IDS);
    expect(harness.adapter.purgeSupabaseRows).toHaveBeenCalledTimes(1);
    expect(harness.calls.indexOf('resource:private_memory')).toBeLessThan(
      harness.calls.indexOf('supabase:delete-bot'),
    );
    expect(harness.calls.indexOf('runtime-containers')).toBeLessThan(
      harness.calls.indexOf('resource:browser_profiles'),
    );
    const completionAudit = harness.audit.mock.calls.find(
      ([entry]) => entry.action === 'bot.purge.completed',
    )?.[0];
    expect(completionAudit).toMatchObject({ botId: null, result: 'success' });
    expect(completionAudit.metadata.botReference).toBe(BOT_ID);
  });

  it('does not let an unrelated manager resume a retained purge journal', async () => {
    const harness = await createHarness({ failResourceOnce: 'credentials' });
    await harness.runtime.start(principal, BOT_ID, startRequest());

    await expect(harness.runtime.get({ ...principal, id: OTHER_USER_ID }, BOT_ID))
      .rejects.toBeInstanceOf(BotPurgeRuntimeError);
  });
});
