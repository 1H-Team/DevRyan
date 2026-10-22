import { createHash } from 'node:crypto';
import { isAutoResumeActive, isTerminalManagedTaskStatus, MANAGED_RESULT_PAGE_MAX_BYTES, MANAGED_RESULT_V2_PAGE_MAX_BYTES, MANAGED_TASK_LIVE_STATUSES, stableStringify } from '@devryan/orchestration-runtime';

const fault = code => Object.assign(new Error(code), { code, statusCode: 409 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (scope, taskID) => `${scope.directory}\0${scope.rootSessionId}\0${taskID}`;
const live = new Set(MANAGED_TASK_LIVE_STATUSES);
const hash=value=>createHash('sha256').update(value).digest('hex');
const samePublicationScope=(left,right)=>['controllerInstanceID','configurationDigest','objectiveID','cancellationGeneration'].every(field=>left?.[field]===right?.[field]);
export function validateNativeManagedResult(result, scope, taskID) {
  if (!record(result?.task) || result.task.taskId !== taskID || result.task.rootSessionId !== scope.rootSessionId
    || result.task.directory !== scope.directory || !(live.has(result.task.status) || isTerminalManagedTaskStatus(result.task.status))) {
    throw fault('native_task_result_scope_invalid');
  }
  if (result.resultEnvelope && (result.resultEnvelope.taskId !== taskID
    || result.resultEnvelope.rootSessionId !== scope.rootSessionId || result.resultEnvelope.directory !== scope.directory
    || result.resultEnvelope.status !== result.task.status)) throw fault('native_task_result_scope_invalid');
  return result;
}
const page = (value, expected) => {
  if (!record(value) || value.taskId !== expected.taskID || value.envelopeId !== expected.envelopeID
    || typeof value.text !== 'string' || Buffer.byteLength(value.text) > (expected.maxPageBytes ?? MANAGED_RESULT_PAGE_MAX_BYTES) || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
    || !Number.isSafeInteger(value.returnedBytes) || value.returnedBytes < 0 || value.returnedBytes > value.totalBytes
    || typeof value.complete !== 'boolean' || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)
    || value.complete !== (value.nextCursor === null) || value.complete !== (value.returnedBytes === value.totalBytes)
    || expected.totalBytes !== undefined && value.totalBytes !== expected.totalBytes
    || expected.returnedBytes !== undefined && value.returnedBytes <= expected.returnedBytes
    || value.returnedBytes - (expected.returnedBytes ?? 0) !== Buffer.byteLength(value.text)) throw fault('native_task_result_page_invalid');
  return structuredClone(value);
};

/** Collection cursors are derived views, never task execution authority. The
 * existing scheduler remains the durable result and recovery owner. */
export function createNativeManagedResultCollection() {
  const collected = new Map();
  return {
    publicationMessageIDs(scope, taskIDs) {
      return [...new Set(taskIDs.flatMap(taskID => (collected.get(key(scope, taskID))?.publications ?? []).map(value => value.messageID)))];
    },
    collect(result, scope, taskID, reset = false) {
      validateNativeManagedResult(result, scope, taskID);
      if (!isTerminalManagedTaskStatus(result.task.status)) throw fault('native_task_wait_not_terminal');
      const envelope = result.resultEnvelope;
      if (!record(envelope) || typeof envelope.envelopeId !== 'string') throw fault('native_task_result_envelope_required');
      if (envelope.action !== null) { collected.delete(key(scope, taskID)); return; }
      const header = result.resultHeader;
      // v2 projections carry no capability copy; the header is only emitted under compactResults.
      const compact = header?.schemaVersion === 1 && (scope.resultContractVersion === 2 || result.capabilities?.policies?.compactResults === true);
      if (header && (!compact || header.taskId !== taskID || header.envelopeId !== envelope.envelopeId
        || header.outcome?.status !== result.task.status || header.outcome?.partial !== envelope.partial
        || header.outcome?.disposition !== envelope.action || !Array.isArray(header.criticalFailures)
        || !Array.isArray(header.verification?.checks)
        || header.criticalFailures.some(value=>typeof value!=='string')
        || envelope.failureReason && !header.criticalFailures.includes(envelope.failureReason)
        || !['passed','failed','not-observed'].includes(header.verification.status)
        || header.verification.checks.some(check=>typeof check?.name!=='string'||!['passed','failed','not-observed'].includes(check.status))
        || ![null,'manual-attention','scheduled-recovery'].includes(header.recovery?.restriction)
        || header.recovery.resumable !== envelope.resumable
        || header.reported?.source !== 'retained-child-preview' || header.reported.authoritative !== false
        || !['complete','blocked','missing','ambiguous'].includes(header.reported.terminalMarker)
        || typeof header.detail?.requiredBeforeDisposition !== 'boolean')) throw fault('native_task_result_header_invalid');
      const detailRequired = !compact || header.detail?.requiredBeforeDisposition !== false;
      if (!detailRequired && (result.task.status !== 'completed' || envelope.partial
        || header.reported?.terminalMarker !== 'complete' || header.reported?.authoritative !== false
        || header.criticalFailures.length || header.recovery?.restriction !== null || header.verification.status !== 'passed'
        || !header.verification.checks.length || header.verification.checks.some(check => check.status !== 'passed'
          || check.evidence?.exitCode !== 0 || typeof check.coverage?.contentHash !== 'string'
          || check.coverage.contentHash !== check.evidence.checkedContentHash)
        || !Number.isSafeInteger(header.detail?.bytes) || header.detail.bytes >= 64 * 1024)) throw fault('native_task_result_header_invalid');
      const maxPageBytes=scope.resultContractVersion===2?MANAGED_RESULT_V2_PAGE_MAX_BYTES:MANAGED_RESULT_PAGE_MAX_BYTES;
      const reference = result.resultReference ? page(result.resultReference, { taskID, envelopeID: envelope.envelopeId, maxPageBytes }) : undefined;
      const metadata=result.metadataReference?page(result.metadataReference,{taskID,envelopeID:envelope.envelopeId,maxPageBytes}):undefined;
      if(metadata&&(result.resultContractVersion!==2||metadata.section!=='metadata'||!/^[a-f0-9]{64}$/.test(metadata.identitySha256??'')))throw fault('native_task_result_page_invalid');
      if (compact && reference?.totalBytes !== header.detail?.bytes) throw fault('native_task_result_header_invalid');
      if (!reference && !metadata && typeof envelope.recoverablePreview !== 'string') throw fault('native_task_result_detail_missing');
      const existing = collected.get(key(scope, taskID));
      if (!reset && existing?.envelopeID === envelope.envelopeId) return;
      collected.set(key(scope, taskID), { envelopeID: envelope.envelopeId, status: result.task.status, detailRequired,
        reference, metadata, maxPageBytes, complete: reference?.complete ?? true });
    },
    stagePublication(scope, taskIDs, invocation, identity, output) {
      if(!record(identity)||!record(identity.attempt)||typeof identity.permitSha256!=='string')throw fault('native_task_publication_scope_invalid');
      const candidate={identity:structuredClone(identity),messageID:invocation.messageID,callID:invocation.callID,
        inputSha256:hash(stableStringify(invocation.input)),outputSha256:hash(JSON.stringify(output))};
      for(const taskID of taskIDs){
        const value=collected.get(key(scope,taskID));if(!value)throw fault('native_task_wait_required');
        const prior=value.publications??[];
        if(prior.some(item=>!samePublicationScope(item.identity,identity)))throw fault('native_task_publication_scope_changed');
        const repeated=prior.find(item=>item.messageID===candidate.messageID&&item.callID===candidate.callID);
        if(repeated){if(repeated.inputSha256!==candidate.inputSha256||repeated.outputSha256!==candidate.outputSha256)throw fault('native_task_publication_changed');continue;}
        if(prior.length>1)throw fault('native_task_publication_pending');
        collected.set(key(scope,taskID),{...value,publications:[...prior,candidate]});
      }
    },
    assertPublished(scope, taskID, snapshot, review = false) {
      const value=collected.get(key(scope,taskID));
      if(!value)throw fault('native_task_wait_required');
      if(!value.publications?.length)throw fault('native_task_result_not_published');
      if(!Array.isArray(snapshot?.messages)||!samePublicationScope(value.publications[0].identity,snapshot.identity))throw fault('native_task_publication_scope_changed');
      const currentIndex=snapshot.messages.findIndex(message=>message.info?.id===snapshot.identity.stepID);
      if(currentIndex<0||snapshot.messages[currentIndex].info.role!=='assistant')throw fault('native_task_review_step_required');
      for(const candidate of value.publications){
        const index=snapshot.messages.findIndex(message=>message.info?.id===candidate.messageID),message=snapshot.messages[index];
        const part=message?.parts?.find(part=>part.type==='tool'&&part.tool==='devryan_task'&&part.callID===candidate.callID);
        if(index<0||message.info.role!=='assistant'||message.info.sessionID!==scope.rootSessionId
          ||part?.state?.status!=='completed'||part.state.metadata?.truncated===true
          ||hash(stableStringify(part.state.input))!==candidate.inputSha256||typeof part.state.output!=='string'
          ||hash(part.state.output)!==candidate.outputSha256)throw fault('native_task_result_not_published');
        if(review&&currentIndex<=index)throw fault('native_task_later_review_step_required');
      }
      // Each next page requires this check first. Retain its latest canonical
      // delivery witness rather than a transcript-sized history of candidates.
      collected.set(key(scope,taskID),{...value,publications:value.publications.slice(-1)});
    },
    next(scope, taskID, cursor) {
      const value = collected.get(key(scope, taskID));
      if (!value) throw fault('native_task_wait_required');
      const expected=value.metadata&&!value.metadata.complete?value.metadata.nextCursor:value.complete?null:value.reference?.nextCursor;
      if (expected!==cursor||expected===null) throw fault('native_task_result_cursor_mismatch');
      return structuredClone(value);
    },
    acceptPage(scope, taskID, cursor, result) {
      const current = this.next(scope, taskID, cursor);
      if(current.metadata&&!current.metadata.complete){
        const metadata=page(result?.metadataReference,{taskID,envelopeID:current.envelopeID,totalBytes:current.metadata.totalBytes,returnedBytes:current.metadata.returnedBytes,maxPageBytes:current.maxPageBytes});
        if(metadata.section!=='metadata'||metadata.identitySha256!==current.metadata.identitySha256)throw fault('native_task_result_page_invalid');
        collected.set(key(scope,taskID),{...current,metadata});return;
      }
      const reference = page(result?.resultReference, { taskID, envelopeID: current.envelopeID,
        totalBytes: current.reference.totalBytes, returnedBytes: current.reference.returnedBytes, maxPageBytes: current.maxPageBytes });
      collected.set(key(scope, taskID), { ...current, reference, complete: reference.complete });
    },
    acceptPublishedPages(scope, reads, invocation, identity, output) {
      const previous = new Map(reads.map(read => [key(scope, read.taskID), collected.get(key(scope, read.taskID))]));
      try {
        for (const read of reads) this.acceptPage(scope, read.taskID, read.cursor, read.result);
        this.stagePublication(scope, reads.map(read => read.taskID), invocation, identity, output);
      } catch (error) {
        // No await or observer separates page advancement from its candidate.
        for (const [id, value] of previous) value ? collected.set(id, value) : collected.delete(id);
        throw error;
      }
    },
    assertDisposition(scope, taskID, action, current) {
      validateNativeManagedResult(current, scope, taskID);
      const value = collected.get(key(scope, taskID));
      if (!value) throw fault('native_task_wait_required');
      if (current.resultEnvelope?.envelopeId !== value.envelopeID || current.task.status !== value.status) throw fault('native_task_result_changed');
      if (current.resultEnvelope.action !== null) throw fault('native_task_already_dispositioned');
      if (value.status === 'completed' && action !== 'continue') throw fault('native_task_completed_requires_continue');
      if (current.task.manualRecoveryRequired === true || isAutoResumeActive(current.resultEnvelope)) throw fault('manual_model_recovery_required');
      if ((value.detailRequired||current.resultHeader?.detail?.requiredBeforeDisposition===true) && !value.complete) throw fault('native_task_result_detail_required');
      if(value.metadata&&!value.metadata.complete)throw fault('native_task_result_metadata_required');
    },
    dispose(scope, taskID) { collected.delete(key(scope, taskID)); },
  };
}
