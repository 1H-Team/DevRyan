import { MAX_MANAGED_TASK_PREVIEW_BYTES, requiresManualModelRecovery } from './contract.js';
import { isAutoResumeActive } from './auto-resume-policy.js';
import { classifyManagedTaskFailure } from './provider-retry-policy.js';

// This is a report from retained child text, never an execution or check fact.
// Missing, conflicting and non-final markers require the existing detail path.
const reportedResult = (preview) => {
  const lines = preview.trimEnd().split(/\r?\n/);
  const markers = [];
  let fence = null;
  let routing = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length
        && !line.slice(delimiter[0].length).trim()) fence = null;
      continue;
    }
    if (fence) continue;
    if (line.startsWith('**Status:**')) markers.push({ index, status: /^\*\*Status:\*\* (complete|blocked)$/.exec(line)?.[1] ?? null });
    if (index === lines.length - 2 && line.startsWith('**Routing:** ') && line.length <= 256) routing = line.slice(13);
  }
  const marker = markers[0];
  const terminalMarker = !markers.length ? 'missing' : markers.length === 1 && marker.status && marker.index === lines.length - 1 && !fence
    ? marker.status : 'ambiguous';
  return { source: 'retained-child-preview', authoritative: false, terminalMarker, routing };
};

export const createCompactResultHeader = ({ task, envelope, checks = [], observedAt }) => {
  if (!envelope || envelope.taskId !== task.taskId || envelope.rootSessionId !== task.rootSessionId) throw new TypeError('Compact result requires a matching durable envelope');
  const restriction = isAutoResumeActive(envelope) ? 'scheduled-recovery'
    : envelope.action === null && requiresManualModelRecovery(task, envelope) ? 'manual-attention' : null;
  const reported = reportedResult(envelope.recoverablePreview);
  const bytes = new TextEncoder().encode(envelope.recoverablePreview).length;
  const detailRequired = reported.terminalMarker !== 'complete' || envelope.status !== 'completed'
    || envelope.partial || Boolean(envelope.failureReason) || Boolean(restriction)
    || checks.length === 0 || checks.some(check => check.status !== 'passed') || bytes >= MAX_MANAGED_TASK_PREVIEW_BYTES;
  return { schemaVersion: 1, taskId: task.taskId, envelopeId: envelope.envelopeId,
    outcome: { status: envelope.status, partial: envelope.partial, disposition: envelope.action },
    reported,
    criticalFailures: [...(envelope.failureReason ? [envelope.failureReason] : []),
      ...(reported.terminalMarker === 'blocked' ? ['Child reports blocked; read the retained result before disposition.'] : [])],
    recovery: { restriction, resumable: envelope.resumable, autoResume: envelope.autoResume ?? null,
      failureKind: classifyManagedTaskFailure(task.failureReason) },
    verification: { status: checks.length === 0 ? 'not-observed'
      : checks.some((entry) => entry.status === 'failed') ? 'failed'
        : checks.every((entry) => entry.status === 'passed') ? 'passed' : 'not-observed', checks,
      observedAt, coverage: checks.length ? 'declared-files-only' : 'no-required-checks-declared' },
    detail: { source: 'canonical-managed-result', taskId: task.taskId, envelopeId: envelope.envelopeId,
      bytes, canonicalRefs: envelope.canonicalRefs, requiredBeforeDisposition: detailRequired },
  };
};
