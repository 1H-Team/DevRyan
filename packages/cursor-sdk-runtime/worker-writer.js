const failed = code => Object.assign(new Error(`Cursor worker output failed (${code}).`), { code });

/** Callback producers cannot await writes. Retain their bounded in-flight I/O
 * and original failure until the terminal producer explicitly drains it. */
export function createCursorWorkerWriter(stdout) {
  const pending = new Set(); let bytes = 0, failure;
  const observe = error => { failure ??= error; };
  stdout.on('error', observe);
  return {
    write(event) {
      const text = JSON.stringify(event) + '\n', size = Buffer.byteLength(text);
      if (pending.size >= 4096 || bytes + size > 8 * 1024 * 1024) observe(failed('CURSOR_STREAM_QUEUE_OVERFLOW'));
      if (failure) { const rejected = Promise.reject(failure); rejected.catch(() => {}); return rejected; }
      bytes += size;
      const work = new Promise((resolve, reject) => { stdout.write(text, error => error ? reject(error) : resolve()); });
      pending.add(work);
      void work.then(() => { pending.delete(work); bytes -= size; }, error => { pending.delete(work); bytes -= size; observe(error); });
      return work;
    },
    get failed() { return Boolean(failure); },
    async report(event) {
      // Reserve only a bounded negative terminal report after pending I/O has
      // settled. This cannot turn a failed queue into successful completion.
      if (event?.type !== 'error' && !(event?.type === 'final-result' && event.result?.ok === false)) throw failed('CURSOR_STREAM_DRAIN_FAILED');
      const boundedError = value => typeof value === 'string' && value.length > 1024 ? value.slice(0, 1024) + '…' : value;
      const bounded = event.type === 'error' ? { ...event, error: boundedError(event.error) }
        : { ...event, result: { ...event.result, error: boundedError(event.result.error) } };
      const text = JSON.stringify(bounded) + '\n';
      if (Buffer.byteLength(text) > 8192) throw failed('CURSOR_STREAM_QUEUE_OVERFLOW');
      await Promise.allSettled([...pending]);
      await new Promise((resolve, reject) => stdout.write(text, error => error ? reject(error) : resolve()));
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (failure) throw failure;
    },
  };
}
