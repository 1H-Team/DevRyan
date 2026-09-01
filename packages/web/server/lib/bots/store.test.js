import { describe, expect, it, vi } from 'vitest';

import { BOT_TABLES, BotStoreError, createBotStore } from './store.js';

const CREATED_AT = '2026-08-22T10:00:00.000Z';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';

const createSupabase = () => ({
  rest: vi.fn(async (_table, options = {}) => {
    if (options.method === 'PATCH') return [{ id: BOT_ID, updated_at: CREATED_AT }];
    if (options.method === 'POST') return [{ id: BOT_ID, created_at: CREATED_AT }];
    return [{ id: BOT_ID, created_at: CREATED_AT }];
  }),
  rpc: vi.fn(async () => []),
  storageUpload: vi.fn(async () => ({ Key: 'object' })),
  storageDownload: vi.fn(async () => Buffer.from('ciphertext')),
  storageDelete: vi.fn(async () => ({ message: 'ok' })),
});

describe('Production Bots Supabase repositories', () => {
  it('defines an explicit, non-wildcard repository select for every Bot table', () => {
    expect(Object.keys(BOT_TABLES)).toEqual([
      'bots',
      'bot_revisions',
      'bot_memberships',
      'bot_channels',
      'bot_channel_acl',
      'bot_credentials',
      'bot_environment_secrets',
      'bot_runs',
      'bot_messages',
      'bot_objects',
      'bot_shared_files',
      'bot_action_attempts',
      'bot_approvals',
      'bot_agent_connections',
      'bot_revision_binding_resolutions',
      'bot_revision_signatures',
      'bot_signer_trust',
      'bot_quota_buckets',
      'bot_quota_reservations',
      'bot_routines',
      'bot_routine_occurrences',
      'bot_memories',
      'bot_memory_versions',
      'bot_memory_sources',
      'bot_library_sources',
      'bot_library_versions',
      'bot_skill_packages',
      'bot_mcp_bindings',
      'bot_audit_events',
      'bot_memory_extraction_jobs',
      'bot_eval_cases',
      'bot_eval_runs',
    ]);
    const store = createBotStore({ supabase: createSupabase() });
    expect(Object.keys(store.repositories)).toEqual(Object.keys(BOT_TABLES));
    for (const repository of Object.values(store.repositories)) {
      expect(repository.select).not.toContain('*');
      expect(repository.select.split(',').length).toBeGreaterThan(5);
    }
  });

  it('uses explicit selects and opaque cursor paging', async () => {
    const supabase = createSupabase();
    const store = createBotStore({ supabase });

    const first = await store.list('bots', { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    await store.list('bots', { limit: 1, cursor: first.nextCursor });

    expect(supabase.rest.mock.calls[0]).toEqual([
      'bots',
      expect.objectContaining({
        select: BOT_TABLES.bots.select,
        query: expect.objectContaining({ order: 'created_at.desc,id.desc', limit: 1 }),
      }),
    ]);
    expect(supabase.rest.mock.calls[1][1].query.or).toContain('created_at.lt.');
    await expect(store.list('bots', { cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ code: 'bot_cursor_invalid', statusCode: 400 });

    await store.list('bot_messages', { filters: { channel_id: BOT_ID }, limit: 1 });
    expect(supabase.rest).toHaveBeenLastCalledWith('bot_messages', expect.objectContaining({
      query: expect.objectContaining({
        channel_id: `eq.${BOT_ID}`,
        order: 'sequence.desc,id.desc',
      }),
    }));

    await store.get('bot_memberships', { user_id: BOT_ID, role: 'manager' });
    expect(supabase.rest).toHaveBeenLastCalledWith('bot_memberships', expect.objectContaining({
      query: expect.objectContaining({
        user_id: `eq.${BOT_ID}`,
        role: 'eq.manager',
      }),
    }));
  });

  it('copies only table-owned fields and never logs ciphertext payloads', async () => {
    const supabase = createSupabase();
    const logger = { debug: vi.fn() };
    const store = createBotStore({ supabase, logger });
    const envelope = { ciphertext: 'must-not-enter-logs' };

    await store.insert('bot_messages', {
      id: 'c0000000-0000-4000-8000-000000000001',
      channel_id: 'd0000000-0000-4000-8000-000000000001',
      run_id: null,
      actor_user_id: 'a0000000-0000-4000-8000-000000000001',
      role: 'user',
      sequence: 1,
      body_envelope: envelope,
      attachment_count: 0,
      finalized_at: CREATED_AT,
    });

    const request = supabase.rest.mock.calls[0][1];
    expect(request.body.body_envelope).toEqual(envelope);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('must-not-enter-logs');
    expect(logger.debug).toHaveBeenCalledWith('[BotsStore]', {
      operation: 'insert',
      table: 'bot_messages',
      fields: expect.arrayContaining(['body_envelope']),
    });
    await expect(store.insert('bots', { name: 'Allowed', requestBody: 'forbidden' }))
      .rejects.toMatchObject({ code: 'bot_request_invalid' });
  });

  it('requires optimistic updated-at revisions and reports conflicts', async () => {
    const supabase = createSupabase();
    const store = createBotStore({ supabase });
    await store.updateIfRevision('bots', { id: BOT_ID }, { name: 'Renamed' }, CREATED_AT);
    expect(supabase.rest).toHaveBeenCalledWith('bots', expect.objectContaining({
      method: 'PATCH',
      body: { name: 'Renamed' },
      query: expect.objectContaining({ updated_at: `eq."${CREATED_AT}"` }),
      select: BOT_TABLES.bots.select,
    }));

    supabase.rest.mockResolvedValueOnce([]);
    await expect(store.updateIfRevision(
      'bots',
      { id: BOT_ID },
      { name: 'Stale' },
      CREATED_AT,
    )).rejects.toMatchObject({ code: 'bot_revision_conflict', statusCode: 409 });
    await expect(store.updateIfRevision(
      'bot_revisions',
      { id: BOT_ID },
      { compiled_hash: 'a'.repeat(64) },
      CREATED_AT,
    )).resolves.toEqual(expect.objectContaining({ id: BOT_ID }));
    await expect(store.updateIfRevision(
      'bot_messages',
      { id: BOT_ID },
      { finalized_at: CREATED_AT },
      CREATED_AT,
    )).rejects.toBeInstanceOf(BotStoreError);
  });

  it('keeps transaction names and Storage operations behind fixed methods', async () => {
    const supabase = createSupabase();
    supabase.rpc.mockResolvedValueOnce([{ id: 'run-1' }]);
    const store = createBotStore({ supabase });
    await expect(store.claimRun({
      computerScopeKey: 'bot:one',
      runtimeOwner: 'runtime-a',
      leaseUntil: '2026-08-22T10:05:00.000Z',
    })).resolves.toEqual({ id: 'run-1' });
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_claim_bot_run', {
      p_computer_scope: 'bot:one',
      p_runtime_owner: 'runtime-a',
      p_lease_until: '2026-08-22T10:05:00.000Z',
    });

    supabase.rpc.mockResolvedValueOnce([{
      id: 'run-1',
      state: 'failed',
      context_snapshot: { failurePhase: 'startup' },
    }]);
    await expect(store.settleRunTerminal({
      runId: 'run-1',
      state: 'failed',
      interruptionKind: 'bot_opencode_request_failed',
      contextSnapshot: { failurePhase: 'startup' },
      finishedAt: '2026-08-22T10:00:01.000Z',
    })).resolves.toEqual(expect.objectContaining({ id: 'run-1', state: 'failed' }));
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_settle_bot_run_terminal', {
      p_run_id: 'run-1',
      p_state: 'failed',
      p_interruption_kind: 'bot_opencode_request_failed',
      p_context_snapshot: { failurePhase: 'startup' },
      p_finished_at: '2026-08-22T10:00:01.000Z',
    });

    supabase.rpc.mockResolvedValueOnce({ actions: [], runs: [], scopeKeys: [] });
    await expect(store.expireApprovals({
      computerScopeKey: 'bot:one',
      now: '2026-08-22T10:00:00.000Z',
    })).resolves.toEqual({ actions: [], runs: [], scopeKeys: [] });
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_expire_bot_approvals', {
      p_computer_scope: 'bot:one',
      p_now: '2026-08-22T10:00:00.000Z',
    });

    await store.storage.upload('devryan-bot-objects', 'object.bin', Buffer.from('x'));
    await store.storage.download('devryan-bot-objects', 'object.bin');
    await store.storage.delete('devryan-bot-objects', ['object.bin']);
    expect(supabase.storageUpload).toHaveBeenCalledTimes(1);
    expect(supabase.storageDownload).toHaveBeenCalledTimes(1);
    expect(supabase.storageDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps memory extraction leases and checkpoint CAS behind fixed transactions', async () => {
    const supabase = createSupabase();
    const job = { run_id: 'run-1', state: 'queued' };
    supabase.rpc
      .mockResolvedValueOnce([{ id: BOT_ID, current_checkpoint_number: 4 }])
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([{ ...job, state: 'leased' }])
      .mockResolvedValueOnce([{ ...job, candidate_envelope: { ciphertext: 'opaque' } }])
      .mockResolvedValueOnce([{ ...job, state: 'succeeded' }]);
    const store = createBotStore({ supabase });

    await expect(store.commitChannelSummary({
      channelId: 'channel-1',
      botId: BOT_ID,
      expectedCheckpointNumber: 3,
      summaryEnvelope: { ciphertext: 'opaque-summary' },
    })).resolves.toMatchObject({ current_checkpoint_number: 4 });
    await store.enqueueMemoryExtractionJob({ runId: 'run-1' });
    await store.claimMemoryExtractionJob({
      leaseOwner: 'worker-1',
      leaseUntil: '2026-08-22T10:05:00.000Z',
    });
    await store.persistMemoryExtractionCandidates({
      runId: 'run-1',
      leaseOwner: 'worker-1',
      candidateEnvelope: { ciphertext: 'opaque' },
    });
    await store.settleMemoryExtractionJob({
      runId: 'run-1',
      leaseOwner: 'worker-1',
      disposition: 'succeeded',
      phase: 'complete',
    });

    expect(supabase.rpc.mock.calls).toEqual([
      ['devryan_commit_bot_channel_summary', {
        p_channel_id: 'channel-1',
        p_bot_id: BOT_ID,
        p_expected_checkpoint_number: 3,
        p_summary_envelope: { ciphertext: 'opaque-summary' },
      }],
      ['devryan_enqueue_bot_memory_extraction_job', { p_run_id: 'run-1' }],
      ['devryan_claim_bot_memory_extraction_job', {
        p_lease_owner: 'worker-1',
        p_lease_until: '2026-08-22T10:05:00.000Z',
      }],
      ['devryan_persist_bot_memory_extraction_candidates', {
        p_run_id: 'run-1',
        p_lease_owner: 'worker-1',
        p_candidate_envelope: { ciphertext: 'opaque' },
      }],
      ['devryan_settle_bot_memory_extraction_job', {
        p_run_id: 'run-1',
        p_lease_owner: 'worker-1',
        p_disposition: 'succeeded',
        p_next_attempt_at: null,
        p_phase: 'complete',
        p_error_code: null,
      }],
    ]);
  });

  it('treats the server-only schema marker as a minimum and fails closed on invalid or older versions', async () => {
    const supabase = createSupabase();
    supabase.rpc.mockResolvedValueOnce('20260824120000');
    const store = createBotStore({ supabase });

    await expect(store.assertSchemaVersion('20260824120000'))
      .resolves.toBe('20260824120000');
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_bot_schema_version', {});

    supabase.rpc.mockResolvedValueOnce('20260826130000');
    await expect(store.assertSchemaVersion('20260824120000'))
      .resolves.toBe('20260826130000');

    supabase.rpc.mockResolvedValueOnce('20260822120000');
    await expect(store.assertSchemaVersion('20260824120000')).rejects.toMatchObject({
      code: 'bot_schema_migration_required',
      statusCode: 503,
      requiredMigration: '20260824120000',
    });

    for (const invalid of [null, '', 'future', '2026082412000a']) {
      supabase.rpc.mockResolvedValueOnce(invalid);
      await expect(store.assertSchemaVersion('20260824120000')).rejects.toMatchObject({
        code: 'bot_schema_migration_required',
        statusCode: 503,
        requiredMigration: '20260824120000',
      });
    }
  });

  it('publishes with the exact saved revision timestamp and compiled hash', async () => {
    const supabase = createSupabase();
    supabase.rpc.mockResolvedValueOnce([{ id: BOT_ID, active_revision_id: 'revision-1' }]);
    const store = createBotStore({ supabase });
    const input = {
      botId: BOT_ID,
      revisionId: 'c0000000-0000-4000-8000-000000000001',
      expectedUpdatedAt: CREATED_AT,
      compiledHash: 'a'.repeat(64),
      actorId: 'a0000000-0000-4000-8000-000000000001',
    };

    await expect(store.publishRevision(input)).resolves.toMatchObject({ id: BOT_ID });
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_publish_bot_revision', {
      p_bot_id: input.botId,
      p_revision_id: input.revisionId,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_compiled_hash: input.compiledHash,
      p_actor_id: input.actorId,
    });

    supabase.rpc.mockResolvedValueOnce([]);
    await expect(store.publishRevision(input)).rejects.toMatchObject({
      code: 'bot_revision_conflict', statusCode: 409,
    });
  });

  it('uses fixed transactions for immutable memory versions and owner channel deletion', async () => {
    const supabase = createSupabase();
    supabase.rpc
      .mockResolvedValueOnce([{ memory: { id: 'memory-1' }, activated: true }])
      .mockResolvedValueOnce([{
        deleted_private_memories: 1,
        retained_shared_memories: 2,
        deleted_messages: 3,
      }]);
    const store = createBotStore({ supabase });
    const input = {
      memoryId: 'memory-1',
      versionId: 'version-1',
      sourceId: 'source-1',
      botId: BOT_ID,
      scope: 'shared',
      subjectUserId: null,
      logicalKey: 'deployment.region',
      encryptedContent: { ciphertext: 'opaque' },
      sensitivity: 'normal',
      confidence: 0.9,
      classifierMetadata: { version: 1 },
      creatorKind: 'classifier',
      createdBy: 'a0000000-0000-4000-8000-000000000001',
      channelId: 'c0000000-0000-4000-8000-000000000001',
      runId: 'd0000000-0000-4000-8000-000000000001',
      messageId: 'e0000000-0000-4000-8000-000000000001',
      sourceKind: 'run',
      sourceMetadata: { messageIds: ['e0000000-0000-4000-8000-000000000001'] },
      expectedUpdatedAt: CREATED_AT,
    };

    await expect(store.commitMemoryVersion(input)).resolves.toMatchObject({ activated: true });
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, 'devryan_commit_bot_memory_version', {
      p_memory_id: input.memoryId,
      p_version_id: input.versionId,
      p_source_id: input.sourceId,
      p_bot_id: input.botId,
      p_scope: input.scope,
      p_subject_user_id: input.subjectUserId,
      p_logical_key: input.logicalKey,
      p_encrypted_content: input.encryptedContent,
      p_sensitivity: input.sensitivity,
      p_confidence: input.confidence,
      p_classifier_metadata: input.classifierMetadata,
      p_creator_kind: input.creatorKind,
      p_created_by: input.createdBy,
      p_channel_id: input.channelId,
      p_run_id: input.runId,
      p_message_id: input.messageId,
      p_source_kind: input.sourceKind,
      p_source_metadata: input.sourceMetadata,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    await expect(store.deleteChannel({
      channelId: input.channelId,
      actorId: input.createdBy,
    })).resolves.toMatchObject({ retained_shared_memories: 2 });
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'devryan_delete_bot_channel', {
      p_channel_id: input.channelId,
      p_actor_id: input.createdBy,
    });
  });

  it('uses one fixed RPC for atomic user-message/run admission and a finalized-only checkpoint gate', async () => {
    const supabase = createSupabase();
    supabase.rpc.mockResolvedValueOnce({
      created: true,
      message: { id: 'message-1' },
      run: { id: 'run-1' },
    });
    const store = createBotStore({ supabase });
    const input = {
      messageId: 'd0000000-0000-4000-8000-000000000001',
      acknowledgmentId: 'd0000000-0000-4000-8000-000000000002',
      runId: 'e0000000-0000-4000-8000-000000000001',
      botId: BOT_ID,
      channelId: 'c0000000-0000-4000-8000-000000000001',
      revisionId: 'f0000000-0000-4000-8000-000000000001',
      idempotencyKey: 'client-1',
      modelSnapshot: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      contextSnapshot: { version: 1 },
      computerScopeKey: `bot:${BOT_ID}`,
      actorUserId: 'a0000000-0000-4000-8000-000000000001',
      bodyEnvelope: { ciphertext: 'opaque' },
      acknowledgmentBodyEnvelope: { ciphertext: 'ack-opaque' },
      attachmentCount: 0,
      finalizedAt: CREATED_AT,
      sharedFiles: [],
    };

    await expect(store.enqueueMessageRun(input)).resolves.toMatchObject({ created: true });
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_enqueue_bot_message_run', {
      p_message_id: input.messageId,
      p_acknowledgment_id: input.acknowledgmentId,
      p_run_id: input.runId,
      p_bot_id: input.botId,
      p_channel_id: input.channelId,
      p_revision_id: input.revisionId,
      p_idempotency_key: input.idempotencyKey,
      p_model_snapshot: input.modelSnapshot,
      p_context_snapshot: input.contextSnapshot,
      p_computer_scope: input.computerScopeKey,
      p_actor_user_id: input.actorUserId,
      p_body_envelope: input.bodyEnvelope,
      p_acknowledgment_body_envelope: input.acknowledgmentBodyEnvelope,
      p_attachment_count: 0,
      p_finalized_at: CREATED_AT,
      p_shared_files: [],
    });

    await store.updateMessageCheckpoint({
      messageId: input.messageId,
      bodyEnvelope: { ciphertext: 'new-opaque' },
      finalizedAt: null,
    });
    expect(supabase.rest).toHaveBeenCalledWith('bot_messages', expect.objectContaining({
      method: 'PATCH',
      query: expect.objectContaining({ id: `eq.${input.messageId}`, finalized_at: 'is.null' }),
      body: { body_envelope: { ciphertext: 'new-opaque' } },
      select: BOT_TABLES.bot_messages.select,
    }));

    await store.listChannelMessagesThrough({
      channelId: input.channelId,
      throughSequence: 17,
      limit: 80,
    });
    expect(supabase.rest).toHaveBeenLastCalledWith('bot_messages', {
      query: {
        channel_id: `eq.${input.channelId}`,
        sequence: 'lte.17',
        order: 'sequence.desc,id.desc',
        limit: 80,
      },
      select: BOT_TABLES.bot_messages.select,
    });

    await store.getPreviousChannelRun({
      channelId: input.channelId,
      beforeQueueSequence: 23,
    });
    expect(supabase.rest).toHaveBeenLastCalledWith('bot_runs', {
      query: {
        channel_id: `eq.${input.channelId}`,
        queue_sequence: 'lt.23',
        order: 'queue_sequence.desc,id.desc',
        limit: 1,
      },
      select: BOT_TABLES.bot_runs.select,
      maybeSingle: true,
    });
  });

  it('uses service-only RPCs for send context, audience, and atomic safe retry', async () => {
    const supabase = createSupabase();
    const channelId = 'c0000000-0000-4000-8000-000000000001';
    const actorUserId = 'a0000000-0000-4000-8000-000000000001';
    const runId = 'e0000000-0000-4000-8000-000000000001';
    const sendContext = {
      bot: { id: BOT_ID },
      channel: { id: channelId, bot_id: BOT_ID },
      revision: { id: 'f0000000-0000-4000-8000-000000000001' },
      membership: { user_id: actorUserId },
      acl: null,
    };
    supabase.rpc
      .mockResolvedValueOnce(sendContext)
      .mockResolvedValueOnce([{ user_id: actorUserId }, { user_id: actorUserId }])
      .mockResolvedValueOnce({ ok: true, run: { id: runId, state: 'queued' } });
    const store = createBotStore({ supabase });

    await expect(store.loadBotSendContext({ channelId, userId: actorUserId }))
      .resolves.toEqual(sendContext);
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, 'devryan_bot_send_context', {
      p_channel_id: channelId,
      p_user_id: actorUserId,
    });

    await expect(store.listChannelAudience(channelId)).resolves.toEqual([actorUserId]);
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'devryan_bot_channel_audience', {
      p_channel_id: channelId,
    });

    await expect(store.retryRun({ runId, actorUserId, now: CREATED_AT }))
      .resolves.toEqual({ id: runId, state: 'queued' });
    expect(supabase.rpc).toHaveBeenNthCalledWith(3, 'devryan_retry_bot_run', {
      p_run_id: runId,
      p_actor_user_id: actorUserId,
      p_now: CREATED_AT,
    });

    supabase.rpc.mockResolvedValueOnce({ ok: false, reason: 'execution_started' });
    await expect(store.retryRun({ runId, actorUserId, now: CREATED_AT }))
      .rejects.toMatchObject({ code: 'bot_run_retry_unavailable', statusCode: 409,
        details: { retryReason: 'execution_started' } });
    supabase.rpc.mockResolvedValueOnce({ ok: false, reason: '__proto__' });
    await expect(store.retryRun({ runId, actorUserId, now: CREATED_AT }))
      .rejects.toMatchObject({ code: 'bot_run_retry_unavailable', statusCode: 409,
        details: { retryReason: 'not_retryable' } });
  });

  it('fails closed when Supabase is absent', async () => {
    const store = createBotStore({ supabase: null });
    expect(store.available).toBe(false);
    await expect(store.get('bots', { id: BOT_ID })).rejects.toMatchObject({
      code: 'bots_supabase_unavailable',
      statusCode: 503,
    });
  });
});
