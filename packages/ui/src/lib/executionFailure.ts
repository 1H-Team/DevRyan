const explanations: Record<string, string> = {
  local_execution_timeout: 'The workspace was not ready before the startup deadline. Retry the subtask.',
  execution_preparation_stalled: 'Workspace preparation stopped making progress. Retry the subtask.',
  workspace_changing: 'Workspace files kept changing during preparation. Pause the writer and retry the subtask.',
  execution_artifacts_unavailable: 'The verified execution runtime is missing or incompatible. Repair or update DevRyan, then restart the server.',
  execution_owner_termination_unconfirmed: 'The previous execution host has not confirmed shutdown. Wait for recovery before retrying.',
  execution_owner_lost: 'The execution host restarted while preparing this work. Retry the subtask.',
  execution_owner_unavailable: 'The execution host is unavailable. Reconnect and retry.',
  payload_too_large: 'This request exceeds the execution input limit. Reduce attached context or start a new task.',
  skill_source_mismatch: 'The selected skill changed during preparation. Retry to load its current version.',
  storage_unavailable: 'There is not enough available storage to prepare or save this work. Free space and retry.',
  mutation_runtime_missing: 'The paired execution runtime is missing. Repair or update the installation before retrying.',
  mutation_runtime_unsupported: 'This runtime cannot provide the required execution protection. Use a supported runtime.',
  session_retention_in_progress: 'Session cleanup is in progress. Retry after it finishes.',
  mutation_history_captured: 'This conversation\'s changes are owned by the DevRyan companion, which is unavailable. Restore it to Revert or Redo.',
  mutation_recovery_pending: 'An interrupted Revert in this project is waiting for the DevRyan companion to finish recovery. Restore it before reverting.',
};

/** Add actionable detail for known execution codes without exposing inputs or stacks. */
export function describeExecutionFailure(value: string): string | undefined {
  for (const [code, message] of Object.entries(explanations)) {
    if (!new RegExp(`\\b${code}\\b`).test(value)) continue;
    if (value.includes('cleanup unconfirmed')) return `Execution could not start and cleanup is still unconfirmed. Wait for recovery before retrying. (${code})`;
    return `${message} (${code})`;
  }
  return undefined;
}
