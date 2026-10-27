import path from 'node:path';

const keys = ['v', 'taskId', 'rootSessionId', 'parentSessionId', 'childSessionId', 'directory', 'dispatchCallId', 'dispatchGroupId',
  'attempt', 'sequence', 'agent', 'providerId', 'modelId', 'variant', 'readOnly', 'anchorID', 'objectiveID', 'cancellationGeneration',
  'generation', 'admissionRevision', 'controllerInstanceID', 'configurationDigest', 'sourceMessageID', 'fingerprint', 'textSha256'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const match = (value, pattern) => typeof value === 'string' && pattern.test(value);

/** Canonical shape only. Current constructor witnesses supply all authority. */
export const isCanonicalManagedTitleMetadata = value => record(value) && value.v === 1
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  && match(value.taskId, /^dvr_task_[A-Za-z0-9_-]{1,128}$/)
  && ['rootSessionId', 'parentSessionId', 'childSessionId'].every(key => match(value[key], /^ses[a-zA-Z0-9_-]{1,128}$/))
  && ['dispatchGroupId', 'anchorID', 'objectiveID', 'sourceMessageID'].every(key => match(value[key], /^msg_[A-Za-z0-9_-]{1,128}$/))
  && typeof value.directory === 'string' && value.directory.length <= 4096 && !value.directory.includes('\0')
  && path.isAbsolute(value.directory) && path.resolve(value.directory) === value.directory
  && ['dispatchCallId', 'controllerInstanceID', 'agent', 'providerId', 'modelId', 'variant'].every(key => text(value[key]))
  && ['attempt', 'sequence'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 1)
  && ['generation', 'admissionRevision', 'cancellationGeneration'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
  && typeof value.readOnly === 'boolean'
  && ['configurationDigest', 'fingerprint', 'textSha256'].every(key => match(value[key], /^[a-f0-9]{64}$/));
