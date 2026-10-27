// Values crossing the session-mutation worker boundary (structured clone plus
// three markers): functions in call inputs become remote callbacks, async
// iterables in results become pulled streams, and errors keep the fields the
// ledger's callers branch on (code, status, committed, rollbackFailed, errors).
const FUNCTION = '__devryanFunction', STREAM = '__devryanStream', ERROR = '__devryanError';
const plain = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const asyncIterable = (value) => value !== null && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function'
  && !ArrayBuffer.isView(value);

// `onFunction(fn)` and `onStream(iterable)` return the id that replaces them.
export function encodeWireValue(value, { onFunction, onStream } = {}) {
  const visit = (item, depth) => {
    if (depth > 64) throw Object.assign(new Error('mutation_wire_too_deep'), { code: 'mutation_wire_too_deep' });
    if (typeof item === 'function') {
      if (!onFunction) throw Object.assign(new Error('mutation_wire_function'), { code: 'mutation_wire_function' });
      return { [FUNCTION]: onFunction(item) };
    }
    if (item instanceof Error) return encodeWireError(item);
    if (asyncIterable(item)) {
      if (!onStream) throw Object.assign(new Error('mutation_wire_stream'), { code: 'mutation_wire_stream' });
      return { [STREAM]: onStream(item) };
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (plain(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry, depth + 1)]));
    return item;
  };
  return visit(value, 0);
}

// `toFunction(id)` and `toStream(id)` build the local stand-ins.
export function decodeWireValue(value, { toFunction, toStream } = {}) {
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    // Structured clone delivers Buffers as plain Uint8Arrays.
    if (item instanceof Uint8Array && !Buffer.isBuffer(item)) return Buffer.from(item.buffer, item.byteOffset, item.byteLength);
    if (!plain(item)) return item;
    if (typeof item[FUNCTION] === 'number' && toFunction) return toFunction(item[FUNCTION]);
    if (typeof item[STREAM] === 'number' && toStream) return toStream(item[STREAM]);
    if (item[ERROR] === true) return decodeWireError(item);
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
  };
  return visit(value);
}

const ERROR_FIELDS = ['code', 'status', 'committed', 'rollbackFailed', 'retryable', 'reason'];
export function encodeWireError(error, depth = 0) {
  if (!(error instanceof Error)) return { [ERROR]: true, name: 'Error', message: String(error) };
  const encoded = { [ERROR]: true, name: error.name, message: error.message, stack: error.stack };
  for (const field of ERROR_FIELDS) {
    const value = error[field];
    if (['string', 'number', 'boolean'].includes(typeof value)) encoded[field] = value;
  }
  if (depth < 4 && Array.isArray(error.errors)) encoded.errors = error.errors.map((entry) => encodeWireError(entry, depth + 1));
  if (depth < 4 && error.cause !== undefined) encoded.cause = encodeWireError(error.cause, depth + 1);
  return encoded;
}
export function decodeWireError(encoded) {
  const errors = Array.isArray(encoded?.errors) ? encoded.errors.map(decodeWireError) : null;
  const options = encoded?.cause ? { cause: decodeWireError(encoded.cause) } : undefined;
  const error = errors ? new AggregateError(errors, encoded.message, options) : new Error(encoded?.message ?? 'mutation_runtime_failed', options);
  if (typeof encoded?.name === 'string' && encoded.name !== error.name) Object.defineProperty(error, 'name', { value: encoded.name, configurable: true });
  for (const field of ERROR_FIELDS) if (encoded?.[field] !== undefined) error[field] = encoded[field];
  if (typeof encoded?.stack === 'string') error.stack = encoded.stack;
  return error;
}
