import fs from 'node:fs/promises';
import path from 'node:path';

const modes = new Set(['upgrade', 'rollback', 'rollback-crash', 'cold-recovery', 'inspection', 'resumed-inspection', 'parent-death']);
const models = new Set(['smoke-write', 'gpt-5-native-smoke']);
const reasons = new Set(['stop', 'tool-calls', 'length', 'content-filter', 'rate-limit']);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

// The pacing proxy buffers this responder before emitting its downstream stream.
// These observations cannot establish downstream cancellation or native settlement.
function providerRequests(rows) {
  return rows.slice(0, 64).map(row => ({
    requestID: /^http_(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(row.requestID) ? row.requestID : null,
    model: models.has(row.model) ? row.model : null,
    startedAt: timestamp(row.startedAt) ? row.startedAt : null,
    requestSha256: /^[a-f0-9]{64}$/.test(row.requestSha256) ? row.requestSha256 : null,
    ...(timestamp(row.completedAt) ? { completedAt: row.completedAt } : {}),
    ...(reasons.has(row.reason) ? { reason: row.reason } : {}),
    ...(typeof row.aborted === 'boolean' ? { aborted: row.aborted } : {}),
    ...(row.error !== undefined ? { errorPresent: true } : {}),
  }));
}

/** Close the owned fixture before copying its finally-published observations.
 * Secondary failures never replace an already failing application assertion. */
export async function finishApplicationLifecycleEvidence({ directory, profile, mode, completed, results, exits,
  processEvidence, issues, primaryFailure }) {
  let secondaryFailure, profileClose = 'passed';
  try { await profile.close(); }
  catch (error) { secondaryFailure = error; profileClose = 'failed'; issues.push('profile-close-failed'); }
  try {
    const rows = profile.evidence.providerRequests;
    await fs.writeFile(path.join(directory, 'application-lifecycle-evidence.json'), JSON.stringify({
      schema: 'devryan.application-lifecycle-evidence/1', status: completed && !issues.length ? 'passed' : 'failed',
      mode: modes.has(mode) ? mode : null, completedModes: results.map(row => row.mode).filter(value => modes.has(value)),
      processEvidence: processEvidence.map(row => ({ pid: row.pid, start: row.start, mode: row.mode })),
      exits: exits.map(row => ({ mode: row.mode, pid: row.pid, code: row.code, signal: row.signal })),
      cleanup: { profileClose, issues },
      providerObservationScope: 'buffered-upstream-http-responder; not downstream cancellation or native Stop settlement',
      providerRequestCount: rows.length, providerRequestsTruncated: rows.length > 64, providerRequests: providerRequests(rows),
    }) + '\n', { mode: 0o600 });
  } catch (error) { secondaryFailure ??= error; issues.push('lifecycle-evidence-write-failed'); }
  const failure = primaryFailure ?? secondaryFailure;
  if (failure && issues.length) {
    // Frozen or non-object thrown values still retain their original identity.
    try { failure.applicationEvidenceIssues = [...issues]; } catch { /* Sidecar retains available cleanup evidence. */ }
  }
  if (!primaryFailure && secondaryFailure) throw secondaryFailure;
}
