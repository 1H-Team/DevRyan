import { normalizePageLimit, validateUuid } from './validation.js';
import { BOT_RETRY_REASONS } from './retry-policy.js';

const table = ({
  columns,
  writable,
  keys = ['id'],
  cursor = ['created_at', 'id'],
  mutable = false,
  cleanup = false,
}) => Object.freeze({
  columns: Object.freeze(columns),
  select: columns.join(','),
  writable: Object.freeze(writable),
  keys: Object.freeze(keys),
  cursor: Object.freeze(cursor),
  mutable,
  cleanup,
});

export const BOT_TABLES = Object.freeze({
  bots: table({
    columns: ['id', 'name', 'title', 'summary', 'avatar_object_id', 'avatar_fallback', 'lifecycle', 'tenancy', 'active_revision_id', 'created_by', 'created_at', 'updated_at', 'retired_at'],
    writable: ['id', 'name', 'title', 'summary', 'avatar_object_id', 'avatar_fallback', 'lifecycle', 'tenancy', 'active_revision_id', 'created_by', 'retired_at'],
    mutable: true,
  }),
  bot_revisions: table({
    columns: ['id', 'bot_id', 'revision_number', 'contract', 'compiled_hash', 'portable_spec', 'spec_hash', 'created_by', 'created_at', 'updated_at', 'activated_at', 'retired_at'],
    writable: ['id', 'bot_id', 'revision_number', 'contract', 'compiled_hash', 'portable_spec', 'spec_hash', 'created_by'],
    mutable: true,
  }),
  bot_memberships: table({
    columns: ['bot_id', 'user_id', 'role', 'assigned_by', 'activated_at', 'revoked_at', 'created_at', 'updated_at'],
    writable: ['bot_id', 'user_id', 'role', 'assigned_by', 'activated_at', 'revoked_at'],
    keys: ['bot_id', 'user_id'],
    cursor: ['created_at', 'user_id'],
    mutable: true,
  }),
  bot_channels: table({
    columns: ['id', 'bot_id', 'owner_user_id', 'lifecycle', 'current_checkpoint_number', 'next_message_sequence', 'summary_envelope', 'last_message_at', 'created_at', 'updated_at', 'archived_at'],
    writable: ['id', 'bot_id', 'owner_user_id', 'lifecycle', 'current_checkpoint_number', 'next_message_sequence', 'summary_envelope', 'last_message_at', 'archived_at'],
    mutable: true,
  }),
  bot_channel_acl: table({
    columns: ['channel_id', 'user_id', 'role', 'invited_by', 'granted_at', 'revoked_at', 'updated_at'],
    writable: ['channel_id', 'user_id', 'role', 'invited_by', 'granted_at', 'revoked_at'],
    keys: ['channel_id', 'user_id'],
    cursor: ['granted_at', 'user_id'],
    mutable: true,
  }),
  bot_credentials: table({
    columns: ['id', 'bot_id', 'provider', 'kind', 'credential_scope', 'owner_user_id', 'local_vault_reference', 'metadata', 'status', 'created_by', 'created_at', 'updated_at', 'revoked_at'],
    writable: ['id', 'bot_id', 'provider', 'kind', 'credential_scope', 'owner_user_id', 'local_vault_reference', 'metadata', 'status', 'created_by', 'revoked_at'],
    mutable: true,
    cleanup: true,
  }),
  bot_environment_secrets: table({
    columns: [
      'id', 'bot_id', 'name', 'local_vault_reference', 'status',
      'created_by', 'created_at', 'updated_at',
    ],
    writable: [
      'id', 'bot_id', 'name', 'local_vault_reference', 'status', 'created_by',
    ],
    mutable: true,
    cleanup: true,
  }),
  bot_runs: table({
    columns: ['id', 'bot_id', 'channel_id', 'revision_id', 'idempotency_key', 'model_snapshot', 'context_snapshot', 'computer_scope_key', 'queue_sequence', 'opencode_segment_id', 'opencode_session_id', 'agent_adapter', 'agent_thread_id', 'agent_execution', 'state', 'lease_generation', 'lease_owner', 'lease_until', 'interruption_kind', 'reconciliation_state', 'created_at', 'updated_at', 'started_at', 'finished_at'],
    writable: ['id', 'bot_id', 'channel_id', 'revision_id', 'idempotency_key', 'model_snapshot', 'context_snapshot', 'computer_scope_key', 'queue_sequence', 'opencode_segment_id', 'opencode_session_id', 'agent_adapter', 'agent_thread_id', 'agent_execution', 'state', 'lease_generation', 'lease_owner', 'lease_until', 'interruption_kind', 'reconciliation_state', 'started_at', 'finished_at'],
    mutable: true,
  }),
  bot_messages: table({
    columns: ['id', 'channel_id', 'run_id', 'actor_user_id', 'role', 'assistant_phase', 'sequence', 'body_envelope', 'attachment_count', 'created_at', 'finalized_at'],
    writable: ['id', 'channel_id', 'run_id', 'actor_user_id', 'role', 'assistant_phase', 'sequence', 'body_envelope', 'attachment_count', 'finalized_at'],
    cursor: ['sequence', 'id'],
  }),
  bot_objects: table({
    columns: ['id', 'bot_id', 'channel_id', 'visibility', 'storage_bucket', 'storage_object_name', 'object_key_envelope', 'ciphertext_hash', 'ciphertext_size', 'wrapped_key', 'content_type', 'provenance', 'created_by', 'created_at', 'updated_at', 'expires_at', 'deleted_at'],
    writable: ['id', 'bot_id', 'channel_id', 'visibility', 'storage_bucket', 'storage_object_name', 'object_key_envelope', 'ciphertext_hash', 'ciphertext_size', 'wrapped_key', 'content_type', 'provenance', 'created_by', 'expires_at', 'deleted_at'],
    mutable: true,
    cleanup: true,
  }),
  bot_shared_files: table({
    columns: [
      'id', 'bot_id', 'channel_id', 'message_id', 'object_id', 'sender_user_id',
      'direction', 'safe_filename', 'content_type', 'plaintext_sha256',
      'plaintext_size', 'computer_path', 'copy_state', 'copy_attempts',
      'error_code', 'source_key', 'created_at', 'updated_at',
    ],
    writable: [
      'id', 'bot_id', 'channel_id', 'message_id', 'object_id', 'sender_user_id',
      'direction', 'safe_filename', 'content_type', 'plaintext_sha256',
      'plaintext_size', 'computer_path', 'copy_state', 'copy_attempts', 'error_code',
      'source_key',
    ],
    mutable: true,
  }),
  bot_action_attempts: table({
    columns: ['id', 'run_id', 'bot_id', 'revision_id', 'credential_id', 'computer_scope_key', 'action_hash', 'idempotency_key', 'tool', 'action', 'target', 'encrypted_args', 'args_digest', 'risk', 'approval_class', 'policy_effect', 'policy_rule_ids', 'decision_expires_at', 'requires_distinct_approver', 'retain_evidence', 'matcher_version', 'policy_facts_digest', 'authoritative_actor_role', 'quota_binding', 'state', 'execution_receipt', 'unknown_outcome', 'reconciliation_decision', 'initiated_by', 'created_at', 'updated_at', 'started_at', 'finished_at'],
    writable: ['id', 'run_id', 'bot_id', 'revision_id', 'credential_id', 'computer_scope_key', 'action_hash', 'idempotency_key', 'tool', 'action', 'target', 'encrypted_args', 'args_digest', 'risk', 'approval_class', 'policy_effect', 'policy_rule_ids', 'decision_expires_at', 'requires_distinct_approver', 'retain_evidence', 'matcher_version', 'policy_facts_digest', 'authoritative_actor_role', 'quota_binding', 'state', 'execution_receipt', 'unknown_outcome', 'reconciliation_decision', 'initiated_by', 'started_at', 'finished_at'],
    mutable: true,
  }),
  bot_approvals: table({
    columns: ['id', 'action_attempt_id', 'action_hash', 'revision_id', 'args_digest', 'matcher_version', 'policy_facts_digest', 'authoritative_actor_role', 'quota_binding', 'approver_user_id', 'decision', 'expires_at', 'created_at'],
    writable: ['id', 'action_attempt_id', 'action_hash', 'revision_id', 'args_digest', 'matcher_version', 'policy_facts_digest', 'authoritative_actor_role', 'quota_binding', 'approver_user_id', 'decision', 'expires_at'],
  }),
  bot_agent_connections: table({
    columns: ['id', 'bot_id', 'name', 'endpoint_url', 'protocol_version', 'auth_mode', 'credential_id', 'model_hint', 'limits', 'descriptor_digest', 'status', 'health', 'created_by', 'created_at', 'updated_at', 'revoked_at'],
    writable: ['id', 'bot_id', 'name', 'endpoint_url', 'protocol_version', 'auth_mode', 'credential_id', 'model_hint', 'limits', 'descriptor_digest', 'status', 'health', 'created_by', 'revoked_at'],
    mutable: true,
  }),
  bot_revision_binding_resolutions: table({
    columns: ['id', 'revision_id', 'binding_kind', 'logical_key', 'portable_digest', 'local_resource_id', 'resolved_digest', 'resolved_by', 'created_at'],
    writable: ['id', 'revision_id', 'binding_kind', 'logical_key', 'portable_digest', 'local_resource_id', 'resolved_digest', 'resolved_by'],
  }),
  bot_revision_signatures: table({
    columns: ['id', 'revision_id', 'spec_hash', 'compiled_hash', 'compiler_version', 'signer_key_id', 'signer_public_key', 'signature', 'created_by', 'created_at'],
    writable: ['id', 'revision_id', 'spec_hash', 'compiled_hash', 'compiler_version', 'signer_key_id', 'signer_public_key', 'signature', 'created_by'],
  }),
  bot_signer_trust: table({
    columns: ['id', 'scope', 'bot_id', 'signer_key_id', 'signer_public_key', 'status', 'trusted_by', 'trusted_at', 'updated_at', 'revoked_at'],
    writable: ['id', 'scope', 'bot_id', 'signer_key_id', 'signer_public_key', 'status', 'trusted_by', 'trusted_at', 'revoked_at'],
    cursor: ['trusted_at', 'id'],
    mutable: true,
  }),
  bot_quota_buckets: table({
    columns: ['id', 'revision_id', 'rule_id', 'quota_scope', 'scope_key', 'window_start', 'window_end', 'limit_count', 'reserved_count', 'consumed_count', 'created_at', 'updated_at'],
    writable: ['id', 'revision_id', 'rule_id', 'quota_scope', 'scope_key', 'window_start', 'window_end', 'limit_count', 'reserved_count', 'consumed_count'],
    mutable: true,
  }),
  bot_quota_reservations: table({
    columns: ['id', 'bucket_id', 'action_attempt_id', 'state', 'reserved_at', 'expires_at', 'consumed_at', 'released_at'],
    writable: ['id', 'bucket_id', 'action_attempt_id', 'state', 'expires_at', 'consumed_at', 'released_at'],
    cursor: ['reserved_at', 'id'],
    mutable: true,
  }),
  bot_routines: table({
    columns: ['id', 'bot_id', 'name', 'schedule_contract', 'timezone', 'missed_policy', 'missed_run_cap', 'status', 'revision_behavior', 'next_occurrence_at', 'last_occurrence_at', 'created_by', 'managed_by', 'created_at', 'updated_at', 'retired_at'],
    writable: ['id', 'bot_id', 'name', 'schedule_contract', 'timezone', 'missed_policy', 'missed_run_cap', 'status', 'revision_behavior', 'next_occurrence_at', 'last_occurrence_at', 'created_by', 'managed_by', 'retired_at'],
    mutable: true,
  }),
  bot_routine_occurrences: table({
    columns: ['id', 'routine_id', 'scheduled_for', 'run_id', 'recovery_disposition', 'state', 'claimed_by', 'claimed_at', 'created_at', 'updated_at'],
    writable: ['id', 'routine_id', 'scheduled_for', 'run_id', 'recovery_disposition', 'state', 'claimed_by', 'claimed_at'],
    cursor: ['scheduled_for', 'id'],
    mutable: true,
  }),
  bot_memories: table({
    columns: ['id', 'bot_id', 'scope', 'subject_user_id', 'logical_key', 'encrypted_content', 'sensitivity', 'confidence', 'active_version_id', 'created_at', 'updated_at', 'tombstoned_at'],
    writable: ['id', 'bot_id', 'scope', 'subject_user_id', 'logical_key', 'encrypted_content', 'sensitivity', 'confidence', 'active_version_id', 'tombstoned_at'],
    mutable: true,
  }),
  bot_memory_versions: table({
    columns: ['id', 'memory_id', 'version_number', 'encrypted_content', 'classifier_metadata', 'creator_kind', 'created_by', 'created_at'],
    writable: ['id', 'memory_id', 'version_number', 'encrypted_content', 'classifier_metadata', 'creator_kind', 'created_by'],
  }),
  bot_memory_sources: table({
    columns: ['id', 'memory_version_id', 'channel_id', 'run_id', 'message_id', 'source_kind', 'source_metadata', 'source_tombstoned_at', 'created_at'],
    writable: ['id', 'memory_version_id', 'channel_id', 'run_id', 'message_id', 'source_kind', 'source_metadata', 'source_tombstoned_at'],
  }),
  bot_library_sources: table({
    columns: ['id', 'bot_id', 'descriptor', 'exclusions', 'provenance', 'host_path_envelope', 'current_published_version_id', 'created_by', 'created_at', 'updated_at', 'retired_at'],
    writable: ['id', 'bot_id', 'descriptor', 'exclusions', 'provenance', 'host_path_envelope', 'current_published_version_id', 'created_by', 'retired_at'],
    mutable: true,
    cleanup: true,
  }),
  bot_library_versions: table({
    columns: ['id', 'source_id', 'version_number', 'manifest_envelope', 'diff_envelope', 'object_ids', 'published_by', 'published_at'],
    writable: ['id', 'source_id', 'version_number', 'manifest_envelope', 'diff_envelope', 'object_ids', 'published_by', 'published_at'],
    cursor: ['published_at', 'id'],
    cleanup: true,
  }),
  bot_skill_packages: table({
    columns: ['id', 'bot_id', 'skill_name', 'display_metadata', 'manifest', 'package_object_id', 'package_digest', 'created_by', 'created_at'],
    writable: ['id', 'bot_id', 'skill_name', 'display_metadata', 'manifest', 'package_object_id', 'package_digest', 'created_by'],
    cleanup: true,
  }),
  bot_mcp_bindings: table({
    columns: ['id', 'bot_id', 'server_name', 'transport', 'display_metadata', 'descriptor_envelope', 'descriptor_digest', 'tool_manifest', 'manifest_digest', 'credential_provider', 'credential_kind', 'created_by', 'created_at'],
    writable: ['id', 'bot_id', 'server_name', 'transport', 'display_metadata', 'descriptor_envelope', 'descriptor_digest', 'tool_manifest', 'manifest_digest', 'credential_provider', 'credential_kind', 'created_by'],
    cleanup: true,
  }),
  bot_audit_events: table({
    columns: ['id', 'event_id', 'bot_id', 'actor_user_id', 'target_type', 'target_id', 'action', 'result', 'metadata', 'created_at'],
    writable: ['event_id', 'bot_id', 'actor_user_id', 'target_type', 'target_id', 'action', 'result', 'metadata', 'created_at'],
  }),
  bot_memory_extraction_jobs: table({
    columns: [
      'run_id', 'bot_id', 'channel_id', 'revision_id', 'state', 'candidate_envelope',
      'candidate_persisted_at', 'attempt_count', 'next_attempt_at', 'lease_owner',
      'lease_until', 'last_phase', 'last_error_code', 'completed_at', 'created_at', 'updated_at',
    ],
    writable: [],
    keys: ['run_id'],
    cursor: ['created_at', 'run_id'],
  }),
  bot_eval_cases: table({
    columns: ['id', 'bot_id', 'name', 'input_envelope', 'expected_outcome', 'created_by', 'created_at', 'updated_at', 'archived_at'],
    writable: ['id', 'bot_id', 'name', 'input_envelope', 'expected_outcome', 'created_by', 'archived_at'],
    mutable: true,
  }),
  bot_eval_runs: table({
    columns: ['id', 'eval_case_id', 'revision_id', 'mode', 'state', 'result', 'initiated_by', 'created_at', 'updated_at', 'started_at', 'finished_at'],
    writable: ['id', 'eval_case_id', 'revision_id', 'mode', 'state', 'result', 'initiated_by', 'started_at', 'finished_at'],
    mutable: true,
  }),
});

const RPC_NAMES = Object.freeze({
  schemaVersion: 'devryan_bot_schema_version',
  sendContext: 'devryan_bot_send_context',
  channelAudience: 'devryan_bot_channel_audience',
  allocateMessageSequence: 'devryan_allocate_bot_message_sequence',
  enqueueMessageRun: 'devryan_enqueue_bot_message_run',
  retryRun: 'devryan_retry_bot_run',
  claimRun: 'devryan_claim_bot_run',
  settleRunTerminal: 'devryan_settle_bot_run_terminal',
  expireApprovals: 'devryan_expire_bot_approvals',
  claimRoutineOccurrence: 'devryan_claim_bot_routine_occurrence',
  createBot: 'devryan_create_bot',
  activateRevision: 'devryan_activate_bot_revision',
  publishRevision: 'devryan_publish_bot_revision',
  commitMemoryVersion: 'devryan_commit_bot_memory_version',
  commitChannelSummary: 'devryan_commit_bot_channel_summary',
  enqueueMemoryExtractionJob: 'devryan_enqueue_bot_memory_extraction_job',
  claimMemoryExtractionJob: 'devryan_claim_bot_memory_extraction_job',
  persistMemoryExtractionCandidates: 'devryan_persist_bot_memory_extraction_candidates',
  settleMemoryExtractionJob: 'devryan_settle_bot_memory_extraction_job',
  deleteChannel: 'devryan_delete_bot_channel',
  pruneAudit: 'devryan_prune_bot_audit',
  purgeResource: 'devryan_purge_bot_resource',
  purgeBot: 'devryan_purge_bot',
  reserveActionQuotas: 'devryan_reserve_bot_action_quotas',
  consumeActionQuotas: 'devryan_consume_bot_action_quotas',
  releaseActionQuotas: 'devryan_release_bot_action_quotas',
  attachRevisionSpec: 'devryan_attach_bot_revision_spec',
});

export class BotStoreError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = 'BotStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const configFor = (tableName) => {
  const config = BOT_TABLES[tableName];
  if (!config) throw new BotStoreError('Unknown Bot repository', 'bot_repository_invalid', 500);
  return config;
};

const cloneValue = (value) => structuredClone(value);

const explicitBody = (tableName, input, config) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BotStoreError(`${tableName} write must be an object`, 'bot_request_invalid', 400);
  }
  const allowed = new Set(config.writable);
  const body = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new BotStoreError(`${tableName} write contains an unsupported field`, 'bot_request_invalid', 400);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) {
      throw new BotStoreError(`${tableName}.${key} is invalid`, 'bot_request_invalid', 400);
    }
    body[key] = cloneValue(descriptor.value);
  }
  if (Object.keys(body).length === 0) {
    throw new BotStoreError(`${tableName} write is empty`, 'bot_request_invalid', 400);
  }
  return body;
};

const postgrestLiteral = (value) => {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string' || value.length > 1_024) {
    throw new BotStoreError('Bot repository filter is invalid', 'bot_request_invalid', 400);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BotStoreError('Bot repository filter is invalid', 'bot_request_invalid', 400);
  }
  if (!/[,.:()"\\]/u.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

const filterQuery = (config, filters = {}) => {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new BotStoreError('Bot repository filters are invalid', 'bot_request_invalid', 400);
  }
  const query = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!config.columns.includes(key) || value === undefined) {
      throw new BotStoreError('Bot repository filter is invalid', 'bot_request_invalid', 400);
    }
    query[key] = value === null ? 'is.null' : `eq.${postgrestLiteral(value)}`;
  }
  return query;
};

const encodeCursor = (row, config) => {
  const [timestampField, identifierField] = config.cursor;
  if (row?.[timestampField] === undefined || row?.[identifierField] === undefined) return null;
  return Buffer.from(JSON.stringify({
    version: 1,
    timestamp: row[timestampField],
    identifier: row[identifierField],
  }), 'utf8').toString('base64url');
};

const decodeCursor = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    throw new BotStoreError('Bot page cursor is invalid', 'bot_cursor_invalid', 400);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new BotStoreError('Bot page cursor is invalid', 'bot_cursor_invalid', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'identifier,timestamp,version'
    || parsed.version !== 1
    || !['string', 'number'].includes(typeof parsed.identifier)
    || !['string', 'number'].includes(typeof parsed.timestamp)) {
    throw new BotStoreError('Bot page cursor is invalid', 'bot_cursor_invalid', 400);
  }
  return parsed;
};

const firstRow = (payload) => (Array.isArray(payload) ? payload[0] || null : payload || null);

export function createBotStore({ supabase, logger = null } = {}) {
  const requireSupabase = () => {
    if (!supabase) {
      throw new BotStoreError(
        'Production Bots require a configured Supabase control plane',
        'bots_supabase_unavailable',
        503,
      );
    }
    return supabase;
  };

  const log = (operation, tableName, fields = []) => {
    logger?.debug?.('[BotsStore]', {
      operation,
      table: tableName,
      fields: [...fields].sort(),
    });
  };

  const get = async (tableName, keys) => {
    const config = configFor(tableName);
    const query = filterQuery(config, keys);
    log('get', tableName, Object.keys(query));
    return firstRow(await requireSupabase().rest(tableName, {
      query: { ...query, limit: 1 },
      select: config.select,
      maybeSingle: true,
    }));
  };

  const list = async (tableName, {
    filters = {},
    cursor = null,
    limit,
  } = {}) => {
    const config = configFor(tableName);
    const pageLimit = normalizePageLimit(limit);
    const query = filterQuery(config, filters);
    const [timestampField, identifierField] = config.cursor;
    query.order = `${timestampField}.desc,${identifierField}.desc`;
    query.limit = pageLimit;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      const timestamp = postgrestLiteral(decoded.timestamp);
      const identifier = postgrestLiteral(decoded.identifier);
      query.or = `(${timestampField}.lt.${timestamp},and(${timestampField}.eq.${timestamp},${identifierField}.lt.${identifier}))`;
    }
    log('list', tableName, Object.keys(filters));
    const rows = await requireSupabase().rest(tableName, { query, select: config.select });
    const items = Array.isArray(rows) ? rows : [];
    return {
      items,
      nextCursor: items.length === pageLimit ? encodeCursor(items[items.length - 1], config) : null,
    };
  };

  const insert = async (tableName, input, {
    onConflict = null,
  } = {}) => {
    const config = configFor(tableName);
    const body = explicitBody(tableName, input, config);
    const query = {};
    if (onConflict !== null) {
      const fields = Array.isArray(onConflict) ? onConflict : [];
      if (fields.length < 1 || fields.some((field) => !config.keys.includes(field))) {
        throw new BotStoreError('Bot repository conflict key is invalid', 'bot_request_invalid', 400);
      }
      query.on_conflict = fields.join(',');
    }
    log('insert', tableName, Object.keys(body));
    return firstRow(await requireSupabase().rest(tableName, {
      method: 'POST',
      query,
      body,
      select: config.select,
      single: true,
      prefer: onConflict ? 'resolution=merge-duplicates' : undefined,
    }));
  };

  const updateIfRevision = async (tableName, keys, changes, expectedUpdatedAt) => {
    const config = configFor(tableName);
    if (!config.mutable || !config.columns.includes('updated_at')) {
      throw new BotStoreError(`${tableName} is immutable`, 'bot_record_immutable', 409);
    }
    if (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      throw new BotStoreError('Expected Bot row revision is required', 'bot_revision_required', 400);
    }
    const body = explicitBody(tableName, changes, config);
    if (config.keys.some((key) => Object.hasOwn(body, key))) {
      throw new BotStoreError('Bot repository identity is immutable', 'bot_record_immutable', 409);
    }
    const query = {
      ...filterQuery(config, keys),
      updated_at: `eq.${postgrestLiteral(expectedUpdatedAt)}`,
    };
    log('update', tableName, Object.keys(body));
    const row = firstRow(await requireSupabase().rest(tableName, {
      method: 'PATCH',
      query,
      body,
      select: config.select,
      maybeSingle: true,
    }));
    if (!row) {
      throw new BotStoreError('Bot row changed before this operation completed', 'bot_revision_conflict', 409);
    }
    return row;
  };

  const deleteCreated = async (tableName, keys) => {
    const config = configFor(tableName);
    if (!config.cleanup) {
      throw new BotStoreError(`${tableName} cannot be deleted`, 'bot_record_immutable', 409);
    }
    const query = filterQuery(config, keys);
    log('cleanup', tableName, Object.keys(query));
    await requireSupabase().rest(tableName, {
      method: 'DELETE',
      query,
      prefer: 'return=minimal',
    });
  };

  const callRpc = async (name, args) => {
    const functionName = RPC_NAMES[name];
    if (!functionName) throw new BotStoreError('Unknown Bot transaction', 'bot_repository_invalid', 500);
    log('rpc', functionName, Object.keys(args));
    return requireSupabase().rpc(functionName, args);
  };

  const assertSchemaVersion = async (expectedVersion) => {
    const actualVersion = await callRpc('schemaVersion', {});
    const migrationVersionPattern = /^\d{14}$/;
    if (migrationVersionPattern.test(expectedVersion)
      && migrationVersionPattern.test(actualVersion)
      && actualVersion >= expectedVersion) return actualVersion;
    const error = new BotStoreError(
      'Production Bots database migration is required',
      'bot_schema_migration_required',
      503,
    );
    error.requiredMigration = expectedVersion;
    throw error;
  };

  const userProfileExists = async (userId) => Boolean(firstRow(await requireSupabase().rest(
    'user_profiles',
    {
      query: { id: `eq.${postgrestLiteral(validateUuid(userId, 'userId'))}`, limit: 1 },
      select: 'id',
      maybeSingle: true,
    },
  )));

  // Resolves member ids to the name and email a Manager recognizes. Only the
  // three display fields are selected; nothing else about a person crosses into
  // the Bots surface.
  const listUserProfiles = async (userIds) => {
    const unique = [...new Set((Array.isArray(userIds) ? userIds : [])
      .map((id) => validateUuid(id, 'userId')))];
    if (unique.length === 0) return new Map();
    const rows = [];
    for (let index = 0; index < unique.length; index += 100) {
      const batch = unique.slice(index, index + 100);
      log('list', 'user_profiles', ['id']);
      const page = await requireSupabase().rest('user_profiles', {
        query: {
          id: `in.(${batch.map((id) => postgrestLiteral(id)).join(',')})`,
          limit: String(batch.length),
        },
        select: 'id,display_name,email',
      });
      rows.push(...(Array.isArray(page) ? page : []));
    }
    return new Map(rows.map((row) => [row.id, row]));
  };

  // Manager-scoped directory for the member picker. Never returns a role,
  // status, or anything else the Bots surface has no use for.
  const searchUserProfiles = async (query, limit = 20) => {
    const term = typeof query === 'string' ? query.trim().slice(0, 120) : '';
    const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
    log('search', 'user_profiles', ['display_name', 'email']);
    const escaped = term.replace(/[\\%,()*]/g, '');
    const rows = await requireSupabase().rest('user_profiles', {
      query: {
        ...(escaped
          ? { or: `(display_name.ilike.*${escaped}*,email.ilike.*${escaped}*)` }
          : {}),
        status: 'eq.active',
        order: 'display_name.asc',
        limit: String(bounded),
      },
      select: 'id,display_name,email',
    });
    return Array.isArray(rows) ? rows : [];
  };

  const rollbackRestoredBot = async (botId) => {
    const normalizedBotId = validateUuid(botId, 'botId');
    log('recovery_rollback', 'bots', ['id']);
    await requireSupabase().rest('bots', {
      method: 'DELETE',
      query: { id: `eq.${postgrestLiteral(normalizedBotId)}` },
      prefer: 'return=minimal',
    });
  };

  const updateMessageCheckpoint = async ({
    messageId,
    bodyEnvelope,
    finalizedAt = null,
    assistantPhase = null,
  } = {}) => {
    if (typeof messageId !== 'string' || !bodyEnvelope || typeof bodyEnvelope !== 'object'
      || Array.isArray(bodyEnvelope)
      || (finalizedAt !== null
        && (typeof finalizedAt !== 'string' || !Number.isFinite(Date.parse(finalizedAt))))
      || (assistantPhase !== null
        && (!['acknowledgment', 'result'].includes(assistantPhase) || finalizedAt === null))) {
      throw new BotStoreError('Bot message checkpoint is invalid', 'bot_request_invalid', 400);
    }
    const body = {
      body_envelope: cloneValue(bodyEnvelope),
      ...(finalizedAt === null ? {} : { finalized_at: finalizedAt }),
      ...(assistantPhase === null ? {} : { assistant_phase: assistantPhase }),
    };
    log('checkpoint', 'bot_messages', Object.keys(body));
    const row = firstRow(await requireSupabase().rest('bot_messages', {
      method: 'PATCH',
      query: {
        id: `eq.${postgrestLiteral(messageId)}`,
        finalized_at: 'is.null',
      },
      body,
      select: BOT_TABLES.bot_messages.select,
      maybeSingle: true,
    }));
    if (!row) {
      throw new BotStoreError(
        'Bot message checkpoint is already finalized or missing',
        'bot_message_finalized',
        409,
      );
    }
    return row;
  };

  const listChannelMessagesThrough = async ({ channelId, throughSequence, limit = 80 } = {}) => {
    if (typeof channelId !== 'string' || !Number.isSafeInteger(throughSequence) || throughSequence < 1
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BotStoreError('Bot channel message boundary is invalid', 'bot_request_invalid', 400);
    }
    log('list_through_sequence', 'bot_messages', ['channel_id', 'sequence']);
    const rows = await requireSupabase().rest('bot_messages', {
      query: {
        channel_id: `eq.${postgrestLiteral(channelId)}`,
        sequence: `lte.${throughSequence}`,
        order: 'sequence.desc,id.desc',
        limit,
      },
      select: BOT_TABLES.bot_messages.select,
    });
    return Array.isArray(rows) ? rows : [];
  };

  const getPreviousChannelRun = async ({ channelId, beforeQueueSequence } = {}) => {
    const normalizedChannelId = validateUuid(channelId, 'channelId');
    if (!Number.isSafeInteger(beforeQueueSequence) || beforeQueueSequence < 1) {
      throw new BotStoreError('Bot run queue boundary is invalid', 'bot_request_invalid', 400);
    }
    log('get_previous', 'bot_runs', ['channel_id', 'queue_sequence']);
    return firstRow(await requireSupabase().rest('bot_runs', {
      query: {
        channel_id: `eq.${postgrestLiteral(normalizedChannelId)}`,
        queue_sequence: `lt.${beforeQueueSequence}`,
        order: 'queue_sequence.desc,id.desc',
        limit: 1,
      },
      select: BOT_TABLES.bot_runs.select,
      maybeSingle: true,
    }));
  };

  const enqueueMessageRun = async (input) => {
    const fields = [
      'messageId', 'acknowledgmentId', 'runId', 'botId', 'channelId', 'revisionId', 'idempotencyKey',
      'modelSnapshot', 'contextSnapshot', 'computerScopeKey', 'actorUserId',
      'bodyEnvelope', 'acknowledgmentBodyEnvelope', 'attachmentCount', 'finalizedAt',
      'sharedFiles',
    ];
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join('\0') !== fields.slice().sort().join('\0')) {
      throw new BotStoreError('Bot message/run admission is invalid', 'bot_request_invalid', 400);
    }
    const result = await callRpc('enqueueMessageRun', {
      p_message_id: input.messageId,
      p_acknowledgment_id: input.acknowledgmentId,
      p_run_id: input.runId,
      p_bot_id: input.botId,
      p_channel_id: input.channelId,
      p_revision_id: input.revisionId,
      p_idempotency_key: input.idempotencyKey,
      p_model_snapshot: cloneValue(input.modelSnapshot),
      p_context_snapshot: cloneValue(input.contextSnapshot),
      p_computer_scope: input.computerScopeKey,
      p_actor_user_id: input.actorUserId,
      p_body_envelope: cloneValue(input.bodyEnvelope),
      p_acknowledgment_body_envelope: cloneValue(input.acknowledgmentBodyEnvelope),
      p_attachment_count: input.attachmentCount,
      p_finalized_at: input.finalizedAt,
      p_shared_files: cloneValue(input.sharedFiles),
    });
    return firstRow(result);
  };

  const loadBotSendContext = async ({ channelId, userId } = {}) => {
    const result = await callRpc('sendContext', {
      p_channel_id: validateUuid(channelId, 'channelId'),
      p_user_id: validateUuid(userId, 'userId'),
    });
    if (result === null || result === undefined) return null;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new BotStoreError('Bot send context is invalid', 'bot_repository_invalid', 500);
    }
    return cloneValue(result);
  };

  const listChannelAudience = async (channelId) => {
    const result = await callRpc('channelAudience', {
      p_channel_id: validateUuid(channelId, 'channelId'),
    });
    if (!Array.isArray(result)) {
      throw new BotStoreError('Bot channel audience is invalid', 'bot_repository_invalid', 500);
    }
    return [...new Set(result.map((row) => validateUuid(row?.user_id, 'audience.userId')))];
  };

  const retryRun = async ({ runId, actorUserId, now } = {}) => {
    const result = await callRpc('retryRun', {
      p_run_id: validateUuid(runId, 'runId'),
      p_actor_user_id: validateUuid(actorUserId, 'actorUserId'),
      p_now: now,
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new BotStoreError('Bot run retry response is invalid', 'bot_repository_invalid', 500);
    }
    if (result.ok === true && result.run && typeof result.run === 'object') {
      return cloneValue(result.run);
    }
    const reasons = Object.freeze({
      not_found: ['Bot run not found', 'bot_run_not_found', 404],
      wrong_actor: ['Only the initiating user can retry this Bot run', 'bot_run_retry_forbidden', 403],
      not_retryable: ['This Bot run cannot be retried safely', 'bot_run_retry_unavailable', 409],
      execution_started: ['This Bot run already started execution', 'bot_run_retry_unavailable', 409],
      revision_changed: ['This Bot run is no longer valid for the active revision', 'bot_run_retry_unavailable', 409],
      channel_unavailable: ['This Bot channel is no longer available', 'bot_run_retry_unavailable', 409],
      access_revoked: ['Bot conversation access is no longer available', 'bot_channel_forbidden', 403],
      attachments_expired: ['These attachments have expired; reattach the files', 'bot_object_expired', 410],
      concurrent_active_run: ['Another Bot run is active in this computer scope', 'bot_run_retry_unavailable', 409],
    });
    const retryReason = BOT_RETRY_REASONS.has(result.reason) ? result.reason : 'not_retryable';
    const [message, code, statusCode] = reasons[retryReason];
    const error = new BotStoreError(message, code, statusCode);
    error.details = Object.freeze({
      retryReason,
    });
    throw error;
  };

  const repositories = Object.fromEntries(Object.keys(BOT_TABLES).map((tableName) => [
    tableName,
    Object.freeze({
      select: BOT_TABLES[tableName].select,
      get: (keys) => get(tableName, keys),
      list: (options) => list(tableName, options),
      insert: (input, options) => insert(tableName, input, options),
      updateIfRevision: (keys, changes, expectedUpdatedAt) => (
        updateIfRevision(tableName, keys, changes, expectedUpdatedAt)
      ),
    }),
  ]));

  return Object.freeze({
    available: Boolean(supabase),
    repositories: Object.freeze(repositories),
    get,
    list,
    insert,
    updateIfRevision,
    deleteCreated,
    assertSchemaVersion,
    enqueueMessageRun,
    loadBotSendContext,
    listChannelAudience,
    retryRun,
    getPreviousChannelRun,
    listChannelMessagesThrough,
    updateMessageCheckpoint,
    userProfileExists,
    listUserProfiles,
    searchUserProfiles,
    rollbackRestoredBot,
    allocateMessageSequence: (channelId) => callRpc('allocateMessageSequence', {
      p_channel_id: channelId,
    }),
    claimRun: async ({ computerScopeKey, runtimeOwner, leaseUntil }) => firstRow(await callRpc('claimRun', {
      p_computer_scope: computerScopeKey,
      p_runtime_owner: runtimeOwner,
      p_lease_until: leaseUntil,
    })),
    settleRunTerminal: async ({ runId, state, interruptionKind, contextSnapshot, finishedAt }) => (
      firstRow(await callRpc('settleRunTerminal', {
        p_run_id: runId,
        p_state: state,
        p_interruption_kind: interruptionKind,
        p_context_snapshot: cloneValue(contextSnapshot),
        p_finished_at: finishedAt,
      }))
    ),
    expireApprovals: async ({ computerScopeKey = null, now }) => callRpc('expireApprovals', {
      p_computer_scope: computerScopeKey,
      p_now: now,
    }),
    reserveActionQuotas: ({ actionAttemptId, revisionId, actorUserId, bindings, now }) => (
      callRpc('reserveActionQuotas', {
        p_action_attempt_id: actionAttemptId,
        p_revision_id: revisionId,
        p_actor_user_id: actorUserId,
        p_bindings: cloneValue(bindings),
        p_now: now,
      })
    ),
    consumeActionQuotas: ({ actionAttemptId, now }) => callRpc('consumeActionQuotas', {
      p_action_attempt_id: actionAttemptId,
      p_now: now,
    }),
    releaseActionQuotas: ({ actionAttemptId, disposition = 'released', now }) => (
      callRpc('releaseActionQuotas', {
        p_action_attempt_id: actionAttemptId,
        p_disposition: disposition,
        p_now: now,
      })
    ),
    attachRevisionSpec: async ({ revisionId, portableSpec, specHash, compiledHash }) => firstRow(
      await callRpc('attachRevisionSpec', {
        p_revision_id: revisionId,
        p_portable_spec: cloneValue(portableSpec),
        p_spec_hash: specHash,
        p_compiled_hash: compiledHash,
      }),
    ),
    claimRoutineOccurrence: async ({ routineId, scheduledFor, occurrenceId }) => firstRow(
      await callRpc('claimRoutineOccurrence', {
        p_routine_id: routineId,
        p_scheduled_for: scheduledFor,
        p_occurrence_id: occurrenceId,
      }),
    ),
    createBot: ({ botId, revisionId, name, tenancy, contract, compiledHash, actorId }) => (
      callRpc('createBot', {
        p_bot_id: botId,
        p_revision_id: revisionId,
        p_name: name,
        p_tenancy: tenancy,
        p_contract: cloneValue(contract),
        p_compiled_hash: compiledHash,
        p_actor_id: actorId,
      })
    ),
    activateRevision: async ({ botId, revisionId, actorId }) => firstRow(
      await callRpc('activateRevision', {
        p_bot_id: botId,
        p_revision_id: revisionId,
        p_actor_id: actorId,
      }),
    ),
    publishRevision: async ({ botId, revisionId, expectedUpdatedAt, compiledHash, actorId }) => {
      const row = firstRow(await callRpc('publishRevision', {
        p_bot_id: botId,
        p_revision_id: revisionId,
        p_expected_updated_at: expectedUpdatedAt,
        p_compiled_hash: compiledHash,
        p_actor_id: actorId,
      }));
      if (!row) {
        throw new BotStoreError(
          'Bot revision changed before it could be published',
          'bot_revision_conflict',
          409,
        );
      }
      return row;
    },
    commitMemoryVersion: async (input) => firstRow(await callRpc('commitMemoryVersion', {
      p_memory_id: input.memoryId,
      p_version_id: input.versionId,
      p_source_id: input.sourceId,
      p_bot_id: input.botId,
      p_scope: input.scope,
      p_subject_user_id: input.subjectUserId,
      p_logical_key: input.logicalKey,
      p_encrypted_content: cloneValue(input.encryptedContent),
      p_sensitivity: input.sensitivity,
      p_confidence: input.confidence,
      p_classifier_metadata: cloneValue(input.classifierMetadata),
      p_creator_kind: input.creatorKind,
      p_created_by: input.createdBy,
      p_channel_id: input.channelId,
      p_run_id: input.runId,
      p_message_id: input.messageId,
      p_source_kind: input.sourceKind,
      p_source_metadata: cloneValue(input.sourceMetadata),
      p_expected_updated_at: input.expectedUpdatedAt,
    })),
    commitChannelSummary: async ({ channelId, botId, expectedCheckpointNumber, summaryEnvelope }) => {
      const row = firstRow(await callRpc('commitChannelSummary', {
        p_channel_id: channelId,
        p_bot_id: botId,
        p_expected_checkpoint_number: expectedCheckpointNumber,
        p_summary_envelope: cloneValue(summaryEnvelope),
      }));
      if (!row) {
        throw new BotStoreError(
          'Bot channel summary checkpoint changed before commit',
          'bot_summary_checkpoint_conflict',
          409,
        );
      }
      return row;
    },
    enqueueMemoryExtractionJob: async ({ runId }) => firstRow(
      await callRpc('enqueueMemoryExtractionJob', { p_run_id: runId }),
    ),
    claimMemoryExtractionJob: async ({ leaseOwner, leaseUntil }) => firstRow(
      await callRpc('claimMemoryExtractionJob', {
        p_lease_owner: leaseOwner,
        p_lease_until: leaseUntil,
      }),
    ),
    persistMemoryExtractionCandidates: async ({ runId, leaseOwner, candidateEnvelope }) => firstRow(
      await callRpc('persistMemoryExtractionCandidates', {
        p_run_id: runId,
        p_lease_owner: leaseOwner,
        p_candidate_envelope: cloneValue(candidateEnvelope),
      }),
    ),
    settleMemoryExtractionJob: async ({
      runId,
      leaseOwner,
      disposition,
      nextAttemptAt = null,
      phase = null,
      errorCode = null,
    }) => firstRow(await callRpc('settleMemoryExtractionJob', {
      p_run_id: runId,
      p_lease_owner: leaseOwner,
      p_disposition: disposition,
      p_next_attempt_at: nextAttemptAt,
      p_phase: phase,
      p_error_code: errorCode,
    })),
    deleteChannel: async ({ channelId, actorId }) => firstRow(await callRpc('deleteChannel', {
      p_channel_id: channelId,
      p_actor_id: actorId,
    })),
    purgeResource: async ({ botId, resourceId, actorId }) => firstRow(await callRpc('purgeResource', {
      p_bot_id: botId,
      p_resource: resourceId,
      p_actor_id: actorId,
    })),
    purgeBot: async ({ botId, actorId }) => firstRow(await callRpc('purgeBot', {
      p_bot_id: botId,
      p_actor_id: actorId,
    })),
    pruneAudit: (retainAfter) => callRpc('pruneAudit', { p_retain_after: retainAfter }),
    storage: Object.freeze({
      upload: (...args) => requireSupabase().storageUpload(...args),
      download: (...args) => requireSupabase().storageDownload(...args),
      delete: (...args) => requireSupabase().storageDelete(...args),
    }),
  });
}
