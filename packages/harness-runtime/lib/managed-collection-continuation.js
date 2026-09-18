import { classifyPrimaryTransportError, isProviderRecoverySupportedRuntimeVersion } from './provider-recovery-policy.js';

// The legacy API error has no machine-readable transport code. Its two exact
// observed strings are admitted only for collecting a user-recovered child.
// This does not expand automatic primary-provider retry eligibility.
export function isCollectionTransportFailure(error, version) {
  if (classifyPrimaryTransportError(error, version)) return true;
  return isProviderRecoverySupportedRuntimeVersion(version) && error?.name === 'APIError'
    && error?.data?.statusCode === undefined && error?.statusCode === undefined
    && error?.data?.status === undefined && error?.status === undefined
    && ['Cannot connect to API: Unable to connect. Is the computer able to access the url?',
      'Cannot connect to API: Was there a typo in the url or port?'].includes(error.data?.message);
}

export function matchesRecoveredCollection(record, check, observed, proof, input) {
  if (!proof || proof.taskId !== input?.taskId || proof.rootSessionId !== record.sessionID
    || proof.directory !== record.directory || typeof proof.envelopeId !== 'string'
    || !/^dvr_result_[a-zA-Z0-9_]+$/.test(proof.envelopeId)
    || !Number.isSafeInteger(proof.attempt) || proof.attempt < 2
    || !Number.isFinite(check.last?.info.time?.completed)
    || !Number.isFinite(proof.createdAt) || proof.createdAt < check.last.info.time.completed
    || !Number.isFinite(proof.finishedAt) || proof.finishedAt < proof.createdAt) return false;
  const anchor = observed.messages.findIndex(m => m.info?.id === record.anchorID);
  return anchor >= 0 && observed.messages.slice(anchor + 1).some(m =>
    m.info?.id === proof.dispatchGroupId && m.info.role === 'assistant');
}

export const collectionIssueCodes = new Set(['managed_continuation_fenced', 'managed_continuation_blocked',
  'managed_objective_mismatch', 'managed_collection_unverified', 'managed_collection_delivery_unconfirmed']);
