import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const sameScope = (left, right) => ['controllerInstanceID', 'configurationDigest', 'sessionID', 'directory'].every(key => left[key] === right[key]);
const textWitness = text => ({ sha256: hash(text), bytes: Buffer.byteLength(text) });
const sameWitness = (left, right) => left?.sha256 === right.sha256 && left?.bytes === right.bytes;

// REST times may be clamped to adjacent message times. Only raw committed
// Started/Ended sequence and timestamps bracket the actual native boundary.
// A provider checkpoint may legitimately contain no textual summary.
export function findQaNativeCompactionBoundaries(rows, { observations = [], sessionID, directory, configurationDigest,
  previousPartIds = [], reason, startedAt = 0 } = {}) {
  const witness = `<WORKTREE_${hash(directory ?? '').slice(0, 12)}>`;
  const relevant = observations.filter(item => item.schema === 1 && item.sessionID === sessionID && item.directory === witness
    && item.configurationDigest === configurationDigest);
  const previous = new Set(previousPartIds), found = [];
  for (const trigger of relevant.filter(item => item.stage === 'compaction-trigger' && item.reason === reason && item.entered >= startedAt)) {
    const scopes = relevant.filter(item => sameScope(item, trigger));
    if (scopes.filter(item => item.stage === 'compaction-trigger' && item.triggerID === trigger.triggerID).length !== 1) continue;
    const outcomes = scopes.filter(item => item.stage === 'compaction-outcome' && item.triggerID === trigger.triggerID);
    const events = scopes.filter(item => item.stage === 'compaction-event' && (item.triggerID === trigger.triggerID
      || reason === 'manual' && item.triggerID === null && item.inputID === trigger.inputID));
    const starts = events.filter(item => item.event === 'started'), ends = events.filter(item => item.event === 'ended');
    if (outcomes.length !== 1 || outcomes[0].status !== 'completed' || starts.length !== 1 || ends.length !== 1
      || events.some(item => item.event === 'failed')) continue;
    const start = starts[0], end = ends[0], outcome = outcomes[0];
    if (start.sequence >= end.sequence || start.created > end.created || end.created > outcome.finished
      || start.created < startedAt || trigger.entered > end.created || !trigger.budget || trigger.inputCount < 1
      || events.some(item => item.reason !== (reason === 'manual' ? 'manual' : 'auto') || item.inputID !== trigger.inputID)) continue;
    // Auto Started has no user inputID; Ended carries the exact running native
    // compaction message ID. Manual must retain the actual submitted inputID.
    if (reason === 'manual' && end.messageID !== trigger.inputID) continue;
    const row = rows.find(item => item.info?.id === end.messageID && item.info.role === 'user' && item.info.sessionID === sessionID);
    const parts = row?.parts?.filter(item => item.type === 'compaction' && item.auto === (reason !== 'manual') && !previous.has(item.id)) ?? [];
    if (parts.length !== 1) continue;
    const summaries = rows.filter(item => item.info?.id === `${end.messageID}:summary` && item.info.role === 'assistant'
      && item.info.parentID === end.messageID && item.info.sessionID === sessionID && item.info.summary === true
      && item.info.time?.completed && !item.info.error);
    if (summaries.length !== 1) continue;
    const summary = summaries[0], textParts = summary.parts.filter(item => item.type === 'text');
    if (textParts.length > 1) continue;
    const text = textParts[0]?.text ?? '', projected = textWitness(text);
    if (!sameWitness(end.witness.text, projected)) continue;
    if (!text.length && ![end.witness.providerState, end.witness.providerContext].some(item => item && item.bytes > 0)) continue;
    if (trigger.budget.estimateContext !== trigger.budget.estimatePrompt.measured + trigger.budget.estimatePrompt.estimated) continue;
    const threshold = trigger.budget.ceiling;
    const thresholdReached = reason === 'auto' && trigger.budget.auto === true && trigger.budget.due === true
      && Number.isFinite(threshold) && threshold > 0 && trigger.budget.estimateContext >= threshold;
    found.push({ source: 'opencode', generation: 2, trigger: reason === 'manual' ? 'manual' : reason === 'auto' ? 'automatic' : 'overflow',
      requestKind: reason === 'manual' ? 'manual' : 'ordinary-context-growth', eventId: parts[0].id,
      boundaryMessageId: row.info.id, summaryMessageId: summary.info.id, observedAt: end.created,
      projectedSummaryCompletedAt: summary.info.time.completed, summarySha256: projected.sha256, summaryBytes: projected.bytes,
      summaryKind: text.length ? 'text' : 'native-provider-checkpoint', auto: reason !== 'manual', overflow: reason === 'overflow',
      threshold, thresholdReached, usageAtTrigger: trigger.budget.estimateContext,
      nativeLifecycle: 'observed', nativeCycle: { startedAt: start.created, completedAt: end.created,
        startedEventID: start.eventID, endedEventID: end.eventID, startedSequence: start.sequence, endedSequence: end.sequence },
      triggerEvidence: trigger, digestWitness: end.witness, nativeEvents: [trigger, start, end, outcome] });
  }
  return found;
}

// This is actual observed policy for QA workload scheduling; each acceptance
// boundary independently requires its own unchanged native budget/estimate.
export function readQaNativeCompactionPolicy(observations, { sessionID, directory, configurationDigest }) {
  const witness = `<WORKTREE_${hash(directory).slice(0, 12)}>`;
  const triggers = observations.filter(item => item.stage === 'compaction-trigger' && item.sessionID === sessionID
    && item.directory === witness && item.configurationDigest === configurationDigest && item.budget !== null)
    .toSorted((left, right) => left.entered - right.entered);
  const trigger = triggers.at(-1);
  if (!trigger || trigger.budget.auto !== true || !Number.isFinite(trigger.budget.ceiling) || trigger.budget.ceiling <= 0) {
    throw Object.assign(new Error('qa_native_compaction_policy_unavailable'), { code: 'qa_native_compaction_evidence_unavailable' });
  }
  return { source: 'native-committed-budget-observation', generation: 2, version: '2.0.20', threshold: trigger.budget.ceiling,
    window: trigger.budget.limits.input ?? trigger.budget.limits.context, modelLimits: trigger.budget.limits,
    automatic: trigger.budget.auto, configuredBuffer: trigger.budget.buffer, keep: trigger.budget.keep,
    triggerID: trigger.triggerID, observedBudget: trigger.budget };
}
