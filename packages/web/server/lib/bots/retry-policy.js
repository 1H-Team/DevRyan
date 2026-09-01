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

export const isBotRunRetryable = (run) => (
  run?.state === 'failed'
  && run.context_snapshot?.failurePhase === 'startup'
  && run.context_snapshot?.retryable === true
  && !hasBotExecutionIdentity(run)
);

// Only the admission placeholder is exempt from output evidence. Text can
// reach a pending row only after an execution identity has been persisted.
export const hasBotRetrySideEffects = async (store, run) => {
  const [messages, actions] = await Promise.all([
    store.repositories.bot_messages.list({ filters: { run_id: run.id, role: 'assistant' }, limit: 3 }),
    store.repositories.bot_action_attempts.list({ filters: { run_id: run.id }, limit: 1 }),
  ]);
  return actions.items.length > 0 || messages.items.some((message) => (
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
