// Only trusted rg readers use this producer boundary. Never splice a notice
// into rg --json: its consumer must receive complete newline records.
export function createNativeSearchOutput({ tool, emit, stop, maxBytes = 64 * 1024, maxRecords = tool === 'glob' ? 1000 : 200 }) {
  let pending = Buffer.alloc(0), returnedBytes = 0, returnedRecords = 0, reason = null;
  const truncate = value => { if (reason) return; reason = value; pending = Buffer.alloc(0); stop(); };
  return {
    write(chunk) {
      if (reason) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      const ready = [];
      const flush = () => { if (ready.length) { emit(Buffer.concat(ready)); ready.length = 0; } };
      while (start < data.length && !reason) {
        const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline + 1;
        const bytes = data.subarray(start, end);
        if (returnedBytes + pending.length + bytes.length > maxBytes) { flush(); truncate('byte_limit'); break; }
        pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes);
        if (newline >= 0) {
          ready.push(pending); returnedBytes += pending.length; returnedRecords++; pending = Buffer.alloc(0);
          if (returnedRecords >= maxRecords) { flush(); truncate('record_limit'); }
        }
        start = end;
      }
      flush();
    },
    finish() { if (pending.length && !reason) throw Object.assign(new Error('native_read_incomplete_line'), { code: 'native_read_incomplete_line' }); },
    metadata() { return reason ? { limitBytes: maxBytes, limitRecords: maxRecords, returnedBytes, returnedRecords, reason } : null; },
  };
}
