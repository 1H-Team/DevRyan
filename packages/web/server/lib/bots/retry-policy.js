// Provider retry advice describes a new provider request, not permission to
// replay a durable Bot run. Keep this projection conservative for old records.
export const hasBotExecutionIdentity = (run) => Boolean(
  run?.agent_thread_id
  || run?.agent_execution?.threadId
  || run?.agent_execution?.invocationId
  || run?.agent_execution?.segmentId
  || run?.opencode_session_id
  || run?.opencode_segment_id,
);

// The dispatcher sets `retryable` only when the failed run produced no visible
// output and no governed action; the retry RPC re-checks that evidence inside
// its transaction. An execution identity alone (a dead agent thread) is not a
// side effect, so it no longer blocks the retry projection.
export const isBotRunRetryable = (run) => (
  run?.state === 'failed'
  && ['startup', 'execution'].includes(run.context_snapshot?.failurePhase)
  && run.context_snapshot?.retryable === true
);

export const operationKindFromRow = (row) => {
  if (row?.target?.operationKind === 'read' || row?.target?.operationKind === 'write') {
    return row.target.operationKind;
  }
  return row?.tool === 'browser'
    && ['download', 'navigate', 'screenshot', 'scroll', 'snapshot', 'status', 'wait']
      .includes(row.action)
    ? 'read'
    : 'write';
};

export const isReadOnlySettledAttempt = (attempt) => {
  if (operationKindFromRow(attempt) !== 'read'
    || !['succeeded', 'failed', 'denied'].includes(attempt?.state)
    || attempt?.unknown_outcome === true) return false;
  const guarantee = attempt?.execution_receipt?.writeGuarantee;
  return guarantee === undefined || guarantee === null || guarantee === 'safe_to_retry';
};

// Only the admission placeholder is exempt from output evidence. Text can
// reach a pending row only after an execution identity has been persisted.
export const hasBotRetrySideEffects = async (store, run) => {
  const [messages, actions] = await Promise.all([
    store.repositories.bot_messages.list({ filters: { run_id: run.id, role: 'assistant' }, limit: 3 }),
    store.repositories.bot_action_attempts.list({ filters: { run_id: run.id }, limit: 25 }),
  ]);
  return Boolean(actions.nextCursor)
    || actions.items.some((attempt) => !isReadOnlySettledAttempt(attempt))
    || messages.items.some((message) => (
    message.assistant_phase !== 'pending'
    || message.finalized_at !== null
    || message.attachment_count !== 0
    || message.actor_user_id !== null
    || message.channel_id !== run.channel_id
    ));
};

export const BOT_RETRY_REASONS = new Set([
  'not_found', 'wrong_actor', 'not_retryable', 'execution_started',
  'revision_changed', 'channel_unavailable', 'access_revoked',
  'concurrent_active_run', 'attachments_expired',
]);
