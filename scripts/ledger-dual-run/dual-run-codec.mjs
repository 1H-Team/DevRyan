// JSON form of the values that cross the ledger seam (session-mutation-host.js
// <-> session-mutation-worker.js). Inside one process those values travel by
// structured clone; a recording on disk, the parent/arm IPC and a ledger
// process over a pipe need text. Every value structured clone can carry and
// JSON cannot is tagged, so decode(encode(v)) is deep-equal to v:
//   { "$dr": "bytes", "base64": "..." }      Buffer / Uint8Array
//   { "$dr": "undefined" }                    undefined (array slot or member)
//   { "$dr": "number", "value": "NaN" }       NaN, Infinity, -Infinity, -0
//   { "$dr": "bigint", "value": "123" }
//   { "$dr": "date", "value": 1700000000000 }
//   { "$dr": "map", "entries": [[k, v], ...] }
//   { "$dr": "set", "values": [...] }
//   { "$dr": "escape", "value": {...} }       a plain object that itself has a "$dr" key
// The census records which tagged types were seen, so a recording shows
// whether any ledger payload carries Map, Set, Date or BigInt (file 26 §8.2).
import { StringDecoder } from 'node:string_decoder';

const TAG = '$dr';

export function createCensus() {
  const counts = {};
  return { note: (kind) => { counts[kind] = (counts[kind] ?? 0) + 1; }, counts };
}

export function encodeValue(value, census) {
  const visit = (item) => {
    if (item === undefined) { census?.note('undefined'); return { [TAG]: 'undefined' }; }
    if (typeof item === 'number') {
      if (Number.isNaN(item) || !Number.isFinite(item) || Object.is(item, -0)) {
        census?.note('number');
        return { [TAG]: 'number', value: Object.is(item, -0) ? '-0' : String(item) };
      }
      return item;
    }
    if (typeof item === 'bigint') { census?.note('bigint'); return { [TAG]: 'bigint', value: item.toString() }; }
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'function' || typeof item === 'symbol') throw new TypeError(`ledger-dual-run codec: cannot encode a ${typeof item}`);
      return item;
    }
    if (item instanceof Uint8Array) { census?.note('bytes'); return { [TAG]: 'bytes', base64: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64') }; }
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) throw new TypeError('ledger-dual-run codec: typed arrays other than Uint8Array are not expected at the seam');
    if (item instanceof Date) { census?.note('date'); return { [TAG]: 'date', value: item.getTime() }; }
    if (item instanceof Map) { census?.note('map'); return { [TAG]: 'map', entries: [...item].map(([key, entry]) => [visit(key), visit(entry)]) }; }
    if (item instanceof Set) { census?.note('set'); return { [TAG]: 'set', values: [...item].map(visit) }; }
    if (Array.isArray(item)) return Array.from(item, visit);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      // Errors cross the seam already encoded (session-mutation-wire.js); any
      // other class instance would lose its prototype under structured clone.
      census?.note(`class:${item.constructor?.name ?? 'anonymous'}`);
    }
    const out = {};
    for (const [key, entry] of Object.entries(item)) out[key] = visit(entry);
    if (Object.hasOwn(item, TAG)) { census?.note('escape'); return { [TAG]: 'escape', value: out }; }
    return out;
  };
  return visit(value);
}

export function decodeValue(value) {
  const visit = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(visit);
    switch (item[TAG]) {
      case undefined: return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
      case 'undefined': return undefined;
      case 'number': return item.value === '-0' ? -0 : Number(item.value);
      case 'bigint': return BigInt(item.value);
      case 'bytes': return Buffer.from(item.base64, 'base64');
      case 'date': return new Date(item.value);
      case 'map': return new Map(item.entries.map(([key, entry]) => [visit(key), visit(entry)]));
      case 'set': return new Set(item.values.map(visit));
      case 'escape': return Object.fromEntries(Object.entries(item.value).map(([key, entry]) => [key, visit(entry)]));
      default: throw new TypeError(`ledger-dual-run codec: unknown tag ${item[TAG]}`);
    }
  };
  return visit(value);
}

/** One message as one line of text (the stdio framing of a ledger process). */
export const encodeLine = (message, census) => `${JSON.stringify(encodeValue(message, census))}\n`;
export const decodeLine = (line) => decodeValue(JSON.parse(line));

/** Splits a byte stream into lines; `onLine` gets each complete line without its newline. */
export function lineReader(onLine) {
  let buffered = '';
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    buffered += decoder.write(chunk);
    for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
    }
  };
}
