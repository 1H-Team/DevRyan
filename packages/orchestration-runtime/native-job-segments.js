const BACKENDS = new Set(['legacy-session', 'native-job', 'cursor']);
const STATES = new Set(['reserved', 'prepared', 'accepted', 'uncertain', 'cancelled']);
const ID_FIELDS = ['jobID', 'notificationID', 'messageID'];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);

export const validateManagedExecutionBackend = value => {
  if (value !== undefined && !BACKENDS.has(value)) throw new TypeError('Invalid managed execution backend');
  return value;
};

export const validateManagedNativeJobSegments = (value, backend) => {
  if (value === undefined) return;
  if (backend !== 'native-job' || !Array.isArray(value)) throw new TypeError('Native job segments require their native backend');
  const identities = new Set();
  for (const segment of value) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)
      || Object.keys(segment).some(key => ![...ID_FIELDS, 'state', 'completion'].includes(key))
      || !ID_FIELDS.every(key => identifier(segment[key])) || segment.messageID === segment.notificationID || !STATES.has(segment.state)
      || segment.completion !== undefined && !['pending', 'done'].includes(segment.completion)) throw new TypeError('Invalid native job segment');
    for (const key of ID_FIELDS) {
      const identity = `${key}:${segment[key]}`;
      if (identities.has(identity)) throw new TypeError('Duplicate native job segment identity');
      identities.add(identity);
    }
  }
};

export const isManagedNativeJobReceiptTransition = (previous, next) => {
  const before = previous.nativeJobSegments, after = next.nativeJobSegments;
  return Array.isArray(before) && Array.isArray(after) && before.length === after.length
    && before.every((segment, index) => ID_FIELDS.every(key => segment[key] === after[index][key])
      && segment.state === after[index].state
      && (segment.completion === after[index].completion || segment.completion === 'pending' && after[index].completion === 'done'));
};

// Adverse attempts can leave a promoted, unfinished canonical user input. Its
// durable done receipt is the restart no-replay proof until verified disposal.
export const requiresManagedNativeInputDisposition = task => task.executionBackend === 'native-job'
  && ['failed', 'aborted', 'interrupted'].includes(task.status) && task.nativeJobSegments?.length > 0;

