export const MANAGED_RESULT_PAGE_MAX_BYTES = 8 * 1024;
export const MANAGED_RESULT_MODES = Object.freeze(['eager', 'reference']);

const CURSOR_PREFIX = 'dvr_result_cursor_v1.';
const MAX_CURSOR_CHARS = 4 * 1024;
const RESULT_PAYLOAD_FIELDS = Object.freeze([
  'taskId',
  'rootSessionId',
  'parentTaskId',
  'childSessionId',
  'directory',
  'status',
  'partial',
  'failureReason',
  'attempt',
  'priorTaskId',
  'executionKind',
  'recoverablePreview',
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const utf8ByteLength = (value) => textEncoder.encode(value).byteLength;
const utf8CodePointByteLength = (codePoint) => {
  if (codePoint <= 0x7F) return 1;
  if (codePoint <= 0x7FF) return 2;
  if (codePoint <= 0xFFFF) return 3;
  return 4;
};

export class ManagedResultReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedResultReferenceError';
    this.code = code;
  }
}

const invalidCursor = (message = 'managed result cursor is invalid') => (
  new ManagedResultReferenceError('invalid_result_cursor', message)
);

const referenceMismatch = (message = 'managed result reference no longer matches the retained result') => (
  new ManagedResultReferenceError('result_reference_mismatch', message)
);

export const resolveManagedResultMode = (value) => {
  if (value === undefined) return 'eager';
  if (value === 'eager' || value === 'reference') return value;
  throw new TypeError('resultMode must be eager or reference');
};

export const managedResultPayloadMatches = (task, resultEnvelope) => {
  if (!isRecord(task) || !isRecord(resultEnvelope)) return false;
  for (const field of RESULT_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(task, field) || !Object.hasOwn(resultEnvelope, field)) return false;
    if (!Object.is(task[field], resultEnvelope[field])) return false;
  }
  if (!Array.isArray(task.canonicalRefs) || !Array.isArray(resultEnvelope.canonicalRefs)) {
    return false;
  }
  try {
    return JSON.stringify(task.canonicalRefs) === JSON.stringify(resultEnvelope.canonicalRefs);
  } catch {
    return false;
  }
};

const encodeBase64Url = (value) => {
  const bytes = textEncoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const decodeBase64Url = (value) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw invalidCursor();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw invalidCursor();
  }
};

const encodeCursor = ({ taskId, envelopeId, stringOffset, returnedBytes, totalBytes }) => {
  const cursor = `${CURSOR_PREFIX}${encodeBase64Url(JSON.stringify({
    v: 1,
    t: taskId,
    e: envelopeId,
    o: stringOffset,
    b: returnedBytes,
    z: totalBytes,
  }))}`;
  if (cursor.length > MAX_CURSOR_CHARS) {
    throw referenceMismatch('managed result identity is too large to encode safely');
  }
  return cursor;
};

const decodeCursor = (cursor) => {
  if (
    typeof cursor !== 'string'
    || cursor.length <= CURSOR_PREFIX.length
    || cursor.length > MAX_CURSOR_CHARS
    || !cursor.startsWith(CURSOR_PREFIX)
  ) {
    throw invalidCursor();
  }
  let value;
  try {
    value = JSON.parse(decodeBase64Url(cursor.slice(CURSOR_PREFIX.length)));
  } catch (error) {
    if (error instanceof ManagedResultReferenceError) throw error;
    throw invalidCursor();
  }
  if (
    !isRecord(value)
    || value.v !== 1
    || typeof value.t !== 'string'
    || !value.t.startsWith('dvr_task_')
    || typeof value.e !== 'string'
    || !value.e.startsWith('dvr_result_')
    || !Number.isSafeInteger(value.o)
    || value.o < 0
    || !Number.isSafeInteger(value.b)
    || value.b < 0
    || !Number.isSafeInteger(value.z)
    || value.z < 0
    || value.b > value.z
  ) {
    throw invalidCursor();
  }
  return {
    taskId: value.t,
    envelopeId: value.e,
    stringOffset: value.o,
    returnedBytes: value.b,
    totalBytes: value.z,
  };
};

const isCodePointBoundary = (value, offset) => {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF);
};

const sliceUtf8Page = (value, stringOffset) => {
  let nextOffset = stringOffset;
  let pageBytes = 0;
  while (nextOffset < value.length) {
    const codePoint = value.codePointAt(nextOffset);
    const width = codePoint > 0xFFFF ? 2 : 1;
    const codePointBytes = utf8CodePointByteLength(codePoint);
    if (pageBytes + codePointBytes > MANAGED_RESULT_PAGE_MAX_BYTES) break;
    pageBytes += codePointBytes;
    nextOffset += width;
  }
  if (nextOffset === stringOffset && stringOffset < value.length) {
    throw invalidCursor('managed result cursor could not make progress');
  }
  return {
    text: value.slice(stringOffset, nextOffset),
    nextOffset,
    pageBytes,
  };
};

const createReferencePage = ({ taskId, envelopeId, preview, stringOffset, returnedBytes }) => {
  const totalBytes = utf8ByteLength(preview);
  const page = sliceUtf8Page(preview, stringOffset);
  const cumulativeBytes = returnedBytes + page.pageBytes;
  const complete = page.nextOffset === preview.length;
  return {
    taskId,
    envelopeId,
    totalBytes,
    text: page.text,
    returnedBytes: cumulativeBytes,
    nextCursor: complete
      ? null
      : encodeCursor({
          taskId,
          envelopeId,
          stringOffset: page.nextOffset,
          returnedBytes: cumulativeBytes,
          totalBytes,
        }),
    complete,
  };
};

const createInitialReference = (task, resultEnvelope) => createReferencePage({
  taskId: task.taskId,
  envelopeId: resultEnvelope.envelopeId,
  preview: resultEnvelope.recoverablePreview,
  stringOffset: 0,
  returnedBytes: 0,
});

export const projectManagedTaskResult = (task, resultEnvelope, resultMode) => {
  const mode = resolveManagedResultMode(resultMode);
  const eager = {
    task,
    ...(resultEnvelope ? { resultEnvelope } : {}),
  };
  if (
    mode !== 'reference'
    || !isRecord(resultEnvelope)
    || typeof resultEnvelope.recoverablePreview !== 'string'
    || utf8ByteLength(resultEnvelope.recoverablePreview) <= MANAGED_RESULT_PAGE_MAX_BYTES
    || !managedResultPayloadMatches(task, resultEnvelope)
  ) {
    return eager;
  }

  const projectedTask = { ...task };
  const projectedEnvelope = { ...resultEnvelope };
  delete projectedTask.recoverablePreview;
  delete projectedEnvelope.recoverablePreview;
  let resultReference;
  try {
    resultReference = createInitialReference(task, resultEnvelope);
  } catch (error) {
    if (error instanceof ManagedResultReferenceError) return eager;
    throw error;
  }
  return {
    task: projectedTask,
    resultEnvelope: projectedEnvelope,
    resultReference,
  };
};

export const projectManagedResultEnvelope = (task, resultEnvelope, resultMode) => {
  const projected = projectManagedTaskResult(task, resultEnvelope, resultMode);
  return {
    resultEnvelope: projected.resultEnvelope,
    ...(projected.resultReference ? { resultReference: projected.resultReference } : {}),
  };
};

export const readManagedResultReference = ({ task, resultEnvelope, resultCursor }) => {
  if (!managedResultPayloadMatches(task, resultEnvelope)) {
    throw referenceMismatch('retained task and result envelope do not match');
  }
  if (
    typeof resultEnvelope.recoverablePreview !== 'string'
    || utf8ByteLength(resultEnvelope.recoverablePreview) <= MANAGED_RESULT_PAGE_MAX_BYTES
  ) {
    throw referenceMismatch('retained result does not require paging');
  }

  const cursor = decodeCursor(resultCursor);
  if (
    cursor.taskId !== task.taskId
    || cursor.taskId !== resultEnvelope.taskId
    || cursor.envelopeId !== resultEnvelope.envelopeId
  ) {
    throw referenceMismatch();
  }

  const preview = resultEnvelope.recoverablePreview;
  const totalBytes = utf8ByteLength(preview);
  if (cursor.totalBytes !== totalBytes) throw referenceMismatch();
  if (
    cursor.stringOffset >= preview.length
    || !isCodePointBoundary(preview, cursor.stringOffset)
    || utf8ByteLength(preview.slice(0, cursor.stringOffset)) !== cursor.returnedBytes
  ) {
    throw invalidCursor();
  }

  return createReferencePage({
    taskId: task.taskId,
    envelopeId: resultEnvelope.envelopeId,
    preview,
    stringOffset: cursor.stringOffset,
    returnedBytes: cursor.returnedBytes,
  });
};
