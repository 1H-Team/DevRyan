import { MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES } from './protocol.js';
import { eventEntryBytes } from './payload-serialization.js';

export const MESSAGE_STREAM_MAX_PENDING_EVENTS = 5_000;

/** Bound both the in-flight filter and pending entries, before socket writes.
 * Cancellation settles callers immediately and aborts delivery. Filters that do
 * not support AbortSignal may finish later; adapters must check signal.aborted
 * again after awaiting authorization and before publishing any bytes.
 */
export function createBoundedEventQueue({ deliver, onClose = () => {},
  getBufferedBytes = () => 0, maxBytes = MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES,
  maxEntries = MESSAGE_STREAM_MAX_PENDING_EVENTS,
  sizeOf = eventEntryBytes } = {}) {
  if (typeof deliver !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid event queue configuration');
  const controller = new AbortController();
  let pending = [], head = 0, active = null, bytes = 0, count = 0, draining = false, closed = false;

  const close = (reason = 'cancelled') => {
    if (closed) return;
    closed = true;
    controller.abort();
    active?.resolve(false);
    active = null;
    for (let index = head; index < pending.length; index += 1) pending[index].resolve(false);
    pending = []; head = 0; bytes = 0; count = 0;
    try { onClose(reason); } catch { /* Queue ownership has already been released. */ }
  };

  const drain = async () => {
    try {
      while (!closed && head < pending.length) {
        const item = pending[head];
        pending[head++] = null;
        if (head >= 1_024) { pending = pending.slice(head); head = 0; }
        active = item;
        const delivered = await deliver(item.entry, controller.signal);
        if (closed) return;
        active = null;
        bytes -= item.bytes; count -= 1;
        item.resolve(delivered !== false);
        if (delivered === false) { close('delivery_failed'); return; }
      }
    } catch {
      close('delivery_failed');
    } finally {
      draining = false;
      pending = []; head = 0;
    }
  };

  const enqueue = entry => {
    if (closed) return Promise.resolve(false);
    let entryBytes;
    try { entryBytes = sizeOf(entry); } catch { close('invalid_event'); return Promise.resolve(false); }
    const buffered = getBufferedBytes();
    if (!Number.isSafeInteger(entryBytes) || entryBytes < 0 || !Number.isFinite(buffered) || buffered < 0) {
      close('invalid_event'); return Promise.resolve(false);
    }
    if (count >= maxEntries || bytes + entryBytes + buffered > maxBytes) {
      close('queue_overflow'); return Promise.resolve(false);
    }
    bytes += entryBytes; count += 1;
    const result = new Promise(resolve => { pending.push({ entry, bytes: entryBytes, resolve }); });
    if (!draining) { draining = true; void drain(); }
    return result;
  };

  return { enqueue, close, getStats: () => ({ pendingBytes: bytes, pendingEvents: count, closed }) };
}
