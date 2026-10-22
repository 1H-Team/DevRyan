import { isAutoResumeActive } from './auto-resume-policy.js';
import { isStoppedRecoveryAvailable, isTerminalManagedTaskStatus, requiresManualModelRecovery } from './contract.js';
import { isProviderPromptRejected } from './provider-retry-policy.js';

// Recovery guidance travels with the failed result that needs it instead of
// sitting in every Orchestrator request. Completed or dispositioned results
// carry none, so ordinary replies and the static prompt prefix stay small.
export const MANAGED_RECOVERY_INSTRUCTIONS = Object.freeze({
  scheduled: 'DevRyan resumes this same child automatically at the scheduled time or on the backup model. Leave it unacknowledged and end the turn with at most one brief status sentence. When it settles, DevRyan sends one synthetic continuation to the idle parent: wait for and disposition this task instead of starting a replacement delegation.',
  manual: 'This result is terminal and awaiting the user. Do not continue, retry, resume, abandon, or otherwise acknowledge it, and never change its model automatically. Leave it pending and end with at most one brief status sentence. Do not repeat recovery instructions; the task card already provides the controls.',
  promptRejected: 'Provider prompt rejection is context-specific: never use `resume`, `recover_in_place`, or `retry_in_place`. When recovery adds value, call `retry` exactly once with only a rewritten `prompt`, preserving the configured agent, model, and thinking level. Make it a compact, semantically complete task capsule: original outcome, required behavior, exact paths or symbols, constraints and non-goals, current workspace state, verification, return contract, and terminal status marker; tell the fresh child to inspect and preserve correct existing changes. Omit the provider error text and URL, transcript history, prior reasoning, duplicated instructions, and irrelevant tool output. If that retry is also rejected, consume any recoverable result, `continue` when relying on it or `abandon` otherwise, then continue within the current scope or report a genuine blocker; do not retry again or enter Model Recovery solely for prompt rejection.',
  failed: 'Consume its partial output. Perform at most one managed recovery, only when another attempt adds value: prefer `resume` only for a resumable timed-out or interrupted result (it observes a still-live child, or sends one transcript-marked same-child continuation when the child is already terminal); use `retry` only when a genuinely new child and replayed task are intended; otherwise `abandon`. If that recovery returns `manualRecoveryRequired`, follow its user-recovery instruction instead of claiming the task will continue automatically.',
});

/** Returns the one recovery instruction a collected, undispositioned result needs, or null. */
export const managedRecoveryInstruction = (task, envelope) => {
  if (!task || !envelope || envelope.action !== null || !isTerminalManagedTaskStatus(task.status)) return null;
  if (isAutoResumeActive(envelope)) return MANAGED_RECOVERY_INSTRUCTIONS.scheduled;
  if (requiresManualModelRecovery(task, envelope) || isStoppedRecoveryAvailable(task, envelope)) return MANAGED_RECOVERY_INSTRUCTIONS.manual;
  if (task.status === 'completed' && !envelope.partial && !task.failureReason) return null;
  if (isProviderPromptRejected(task.failureReason)) return MANAGED_RECOVERY_INSTRUCTIONS.promptRejected;
  return task.status === 'completed' ? null : MANAGED_RECOVERY_INSTRUCTIONS.failed;
};
