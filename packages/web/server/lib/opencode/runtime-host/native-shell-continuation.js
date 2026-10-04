import { isNativeStatusRecord } from '../../../../../shared-runtime/lib/native-message-status.js';
import { currentObjectiveUser, isNativeCompactionRecord } from '@openchamber/harness-runtime/lib/objective-identity.js';

/** Metadata locates a job; only the current ledger and real receipt prove it. */
export function createNativeShellContinuationVerifier({ runtime, getShellJobReceipt }) {
  return async (record, observation, targetUserID) => {
    const session = observation?.session, messages = observation?.messages;
    if (observation?.complete !== true || session?.id !== record.sessionID || session.directory !== record.directory
      || session.parentID || session.time?.archived || session.revert || !Array.isArray(messages) || messages.length > 10_000) return null;
    const ids = new Set();
    for (const message of messages) {
      if (typeof message.info?.id !== 'string' || message.info.sessionID !== record.sessionID
        || ids.has(message.info.id) || !['user', 'assistant'].includes(message.info.role)) return null;
      ids.add(message.info.id);
    }
    const anchor = messages.findIndex(message => message.info.id === record.anchorID && message.info.role === 'user' && !isNativeStatusRecord(message));
    const users = messages.slice(anchor).filter(message => message.info.role === 'user' && !isNativeStatusRecord(message));
    if (anchor < 0 || users.at(-1)?.info.id !== targetUserID || !users.some(message => message.info.id === currentObjectiveUser(record))) return null;
    const scope = { directory: record.directory, sessionID: record.sessionID };
    const before = await runtime.nativeAdmissionState(scope);
    if (before.held || before.reverting) return null;
    const chain = new Set([record.anchorID]);
    let shell = false;
    for (const user of users.slice(1)) {
      const metadata = user.info.metadata;
      if (isNativeCompactionRecord(user) || user.info.id === record.recoveryID || user.info.id === record.continuationID) {
        chain.add(user.info.id);
        continue;
      }
      if (metadata?.source !== 'shell' || typeof metadata.jobID !== 'string' || metadata.shellID !== metadata.jobID) return null;
      const { lease, receipt } = await getShellJobReceipt({ ...scope, jobID: metadata.jobID });
      const job = lease?.nativeShellJob;
      if (lease?.directory !== record.directory || lease.scope?.sessionID !== record.sessionID
        || !['published', 'cancelled'].includes(lease.state) || receipt?.terminated !== true || receipt.confined !== true
        || job?.jobID !== metadata.jobID || job.notificationID !== user.info.id || job.deliveredID !== user.info.id
        || !chain.has(lease.scope.userMessageID)) return null;
      const sourceIndex = messages.findIndex(message => message.info.id === lease.scope.messageID);
      const source = messages[sourceIndex];
      if (sourceIndex <= anchor || sourceIndex >= messages.indexOf(user) || source.info.role !== 'assistant'
        || source.info.parentID !== lease.scope.userMessageID || source.turnOwnership?.source !== 'native-sequence'
        || source.turnOwnership.userMessageID !== lease.scope.userMessageID
        || !source.parts?.some(part => part.type === 'tool' && part.callID === lease.scope.callID && part.tool === 'bash'
          && ['completed', 'error'].includes(part.state?.status))) return null;
      chain.add(user.info.id);
      shell = true;
    }
    // A hold/Revert racing the proof invalidates the whole observation.
    const after = await runtime.nativeAdmissionState(scope);
    return shell && !after.held && !after.reverting && after.revision === before.revision ? { kind: 'native-shell' } : null;
  };
}
